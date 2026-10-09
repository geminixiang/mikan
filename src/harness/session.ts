import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ImageContent,
  Message,
  Model,
  Models,
  ProviderRequestOptions,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { contentText, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  AgentDoc,
  DEFAULT_COMPACTION_POLICY,
  CompactionTask,
  GenerationTask,
  LiveDoc,
  ToolTask,
  defineExtension,
  hook,
  section,
  watchEvents,
  type AgentEvent as DurableEvent,
  type AgentEventStream,
  type Conversation,
  type MessageChange,
  type ToolExecutionApi,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { SessionStore } from "../sessions/session-store.js";
import type { CompactOutcome } from "../types.js";
import type { AttachedSessionHarness, SessionRunStatus } from "../sessions/types.js";
import type {
  BudgetSettings,
  CompactionSettings,
  HarnessEvent,
  HarnessEventListener,
  HarnessSettings,
  MikanAgentSessionOptions,
  MikanHarnessTool,
  MikanToolInput,
  MikanToolResult,
  SubagentUsage,
  SubagentUsageSink,
  RetrySettings,
} from "./types.js";

import * as log from "../log.js";
import { ToolLoopGuard } from "./loop-guard.js";
import { adaptAgentTool, isHarnessTool } from "./tools/pi-tools.js";
import { START_TASK_TOOL, TASK_STATUS_TOOL } from "./tools/task.js";
import { createCodemodeTool, isCodemodeCallable, withScriptCallNote } from "./tools/codemode.js";
import { renderMcpServersSection } from "./mcp.js";
import { createToolSearchTool } from "./tools/tool-search.js";
import { withSecretRedaction } from "./tools/secret-redaction.js";
import { errorMessage } from "../unknown-values.js";

const context: Context = BACKGROUND_CONTEXT;
const COMPACTION_REQUEST = Symbol("compaction-request");

interface RunTally {
  usage: SubagentUsage;
  llmCalls: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  startedAt: number;
  endedAt?: number;
}

interface RunOptions {
  images?: ImageContent[];
  budget?: BudgetSettings;
  tools?: MikanToolInput[];
  allowTaskHandoff?: boolean;
  allowTaskStatus?: boolean;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class MikanAgentSession {
  readonly sessionStore: SessionStore;
  readonly model: Model<Api>;
  private readonly settings: HarnessSettings;
  private readonly listeners = new Set<HarnessEventListener>();
  private systemPrompt: string;
  private attached: AttachedSessionHarness | undefined;
  private runActive = false;
  private runAborted = false;
  private cancellation: Promise<void> | undefined;
  private cancellationError: unknown;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineNotification: Promise<void> | undefined;
  private runBudget: BudgetSettings = {};
  private budgetExceededReason: string | undefined;
  private retryAttempt = 0;
  private runMessages: AgentMessage[] = [];
  private streamingContent: AssistantMessage["content"] = [];
  private readonly toolArgs = new Map<string, unknown>();
  private loopGuard = new ToolLoopGuard();
  private readonly loopNotices = new Map<string, string>();
  private runStarted = false;
  private runEndSeen = false;
  private observedUsage: Usage = createEmptyUsage();
  private requestRunId: string | undefined;
  private activeRequest: { token: symbol; runId: string } | undefined;
  private runEnded: Deferred = deferred();
  private lastSessionRunStatus: SessionRunStatus | undefined;
  private tally: RunTally = {
    usage: createEmptyUsage(),
    llmCalls: 0,
    toolCalls: 0,
    toolCallCounts: {},
    startedAt: 0,
  };

  constructor(private readonly options: MikanAgentSessionOptions) {
    this.sessionStore = options.sessionStore;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.settings = resolveHarnessSettings(options.settings);
  }

  get lastRunMessages(): readonly AgentMessage[] {
    return this.runMessages;
  }

  get isActiveRun(): boolean {
    return this.runActive;
  }

  setSystemPrompt(prompt: string): void {
    if (this.runActive) throw new Error("Cannot change the system prompt during a run");
    this.systemPrompt = prompt;
  }

  getLastRunStats(): Readonly<{
    usage: SubagentUsage;
    tokens: number;
    costUsd: number;
    llmCalls: number;
    toolCalls: number;
    toolCallCounts: Record<string, number>;
    durationMs: number;
    budgetExceededReason?: string;
    status?: SessionRunStatus;
  }> {
    return {
      usage: copyUsage(this.tally.usage),
      tokens: this.tally.usage.totalTokens,
      costUsd: this.tally.usage.cost.total,
      llmCalls: this.tally.llmCalls,
      toolCalls: this.tally.toolCalls,
      toolCallCounts: { ...this.tally.toolCallCounts },
      durationMs:
        this.tally.startedAt > 0 ? (this.tally.endedAt ?? Date.now()) - this.tally.startedAt : 0,
      budgetExceededReason: this.budgetExceededReason || undefined,
      status: this.lastSessionRunStatus,
    };
  }

  captureExternalUsageSink(): SubagentUsageSink {
    const tally = this.tally;
    return async (usage) => {
      addUsage(tally.usage, usage);
      if (this.tally !== tally || !this.runActive || this.budgetExceededReason) return;
      const reason = this.resourceOverBudgetReason();
      if (reason) await this.exceedBudget(reason);
    };
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, options?: RunOptions): Promise<void> {
    await this.run(text, options);
  }

  async compact(instructions?: string): Promise<CompactOutcome> {
    if (this.runActive) throw new Error("Agent is already processing a prompt");
    const { harness, conversation } = await this.attach();
    const tokensBefore = await contextTokens(conversation);
    const taskId = await conversation.compact(instructions, context);
    const { outcome } = (await harness.waitForTask(taskId, context)).state;
    if (outcome.status !== "completed") {
      throw new Error(
        outcome.status === "failed" ? outcome.error.message : `Compaction ${outcome.status}`,
      );
    }
    const submissionId = outcome.result.submissionId;
    if (submissionId === undefined) return { compacted: false };
    const placed = await (await harness.submission(submissionId, context))?.wait(context);
    if (placed?.status !== "done") return { compacted: false };
    return { compacted: true, tokensBefore, tokensAfter: await contextTokens(conversation) };
  }

  async steer(text: string): Promise<boolean> {
    if (!this.runActive || this.runAborted || !this.attached) return false;
    await this.attached.conversation.submit(
      { type: "input", content: text, whenBusy: "steer" },
      context,
    );
    return true;
  }

  private async run(text: string, options?: RunOptions): Promise<void> {
    if (this.runActive) throw new Error("Agent is already processing a prompt");
    this.runActive = true;
    this.runAborted = false;
    this.budgetExceededReason = undefined;
    this.cancellation = undefined;
    this.cancellationError = undefined;
    this.retryAttempt = 0;
    this.runMessages = [];
    this.runStarted = false;
    this.runEndSeen = false;
    this.runEnded = deferred();
    this.activeRequest = undefined;
    this.requestRunId = undefined;
    this.loopGuard = new ToolLoopGuard();
    this.loopNotices.clear();
    this.runBudget = { ...this.settings.budget, ...options?.budget };
    this.lastSessionRunStatus = undefined;
    this.tally = {
      usage: createEmptyUsage(),
      llmCalls: 0,
      toolCalls: 0,
      toolCallCounts: {},
      startedAt: Date.now(),
    };
    let runFailure: { error: unknown } | undefined;
    let stream: AgentEventStream | undefined;
    let status: SessionRunStatus = "completed";
    try {
      if (!(await this.checkCallBudget())) return;
      this.armDeadline();
      const auth = await this.options.models.getAuth(this.model);
      if (this.runAborted) return;
      if (!auth)
        throw new Error(
          `No credentials for provider "${this.model.provider}". Set the provider API key environment variable.`,
        );
      const attached = await this.attach();
      if (this.runAborted) return;
      const tools = this.toHarnessTools(options?.tools ?? this.options.tools).filter(
        (tool) =>
          (tool.name !== START_TASK_TOOL || options?.allowTaskHandoff === true) &&
          (tool.name !== TASK_STATUS_TOOL || options?.allowTaskStatus === true),
      );
      await this.installRunTools(attached, tools);
      if (!(await this.checkCallBudget())) return;
      await this.sessionStore.recordRun({ startedAt: Date.now() });
      stream = await watchEvents(attached.harness, attached.conversation.id, context);
      this.observedUsage = sumUsageState(stream.snapshot.usage);
      stream.start((events) => this.handleDurableEvents(events));
      status = await this.drive(attached, text, options?.images);
    } catch (error) {
      runFailure = { error };
      status = "failed";
      throw error;
    } finally {
      if (status !== "failed" && this.runAborted) status = "aborted";
      await this.cleanupRun(runFailure, stream, status);
    }
  }

  private async drive(
    { harness, conversation }: AttachedSessionHarness,
    text: string,
    images?: ImageContent[],
  ): Promise<SessionRunStatus> {
    const interrupted = (await harness.snapshot(LiveDoc, conversation.id, context))?.run;
    if (interrupted) {
      log.logWarning("Aborting a run interrupted before this process started");
      await conversation.abort(context);
    }
    const content: string | (TextContent | ImageContent)[] =
      images && images.length > 0 ? [{ type: "text", text }, ...images] : text;
    const submission = await conversation.submit(
      { type: "input", content, whenBusy: "reject" },
      context,
    );
    if (this.runAborted) this.requestCancellation();
    const settled = await submission.wait(context);
    if (this.runStarted) await this.runEnded.promise;
    if (settled.status === "done") return "completed";
    if (this.runAborted || settled.reason === "aborted") return "aborted";
    if (settled.reason === "model_error") return "failed";
    throw new Error(`Pi run failed: ${settled.reason}`);
  }

  private async cleanupRun(
    runFailure: { error: unknown } | undefined,
    stream: AgentEventStream | undefined,
    status: SessionRunStatus,
  ): Promise<void> {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await this.cancellation;
      await this.deadlineNotification;
      await stream?.stop();
      if (this.attached) {
        await this.sessionStore.recordRun({ endedAt: Date.now(), status });
      }
      if (this.cancellationError) throw this.cancellationError;
    } catch (error) {
      cleanupFailure = { error };
    } finally {
      this.toolArgs.clear();
      this.loopNotices.clear();
      this.cancellation = undefined;
      this.deadlineNotification = undefined;
      this.tally.endedAt = Date.now();
      this.lastSessionRunStatus = status;
      this.runActive = false;
    }
    if (!cleanupFailure) return;
    if (runFailure) {
      throw new AggregateError(
        [runFailure.error, cleanupFailure.error],
        "Agent run and cancellation cleanup failed",
        { cause: runFailure.error },
      );
    }
    throw cleanupFailure.error;
  }

  abort(reason = "cancelled"): void {
    if (!this.runActive) return;
    const firstAbort = !this.runAborted;
    this.runAborted = true;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    if (firstAbort && this.activeRequest !== undefined) {
      log.logInfo(
        `LLM request aborted ${JSON.stringify({ abort_reason: reason, run_id: this.activeRequest.runId })}`,
      );
    }
    this.requestCancellation();
  }

  private requestCancellation(): void {
    if (!this.attached || this.cancellation) return;
    this.cancellation = this.attached.conversation.abort(context).catch((error: unknown) => {
      this.cancellationError = error;
    });
  }

  private async attach(): Promise<AttachedSessionHarness> {
    if (this.attached) return this.attached;
    const { retry, compaction } = this.settings;
    this.attached = await this.sessionStore.bindHarness({
      models: this.options.models.models,
      requestModels: this.trackedModels(this.options.models.models),
      env: () => this.options.toolContext?.env,
      settings: { retry, compaction },
      onReport: (error) => log.logWarning("Durable harness report", errorMessage(error)),
    });
    return this.attached;
  }

  private trackedModels(models: Models): Models {
    const track = <TOptions extends ProviderRequestOptions>(
      options: TOptions | undefined,
      token: symbol,
    ): TOptions => {
      const onPayload = options?.onPayload;
      const tracked: TOptions = {
        ...options,
        onPayload: async (
          ...args: Parameters<NonNullable<ProviderRequestOptions["onPayload"]>>
        ) => {
          const transformed = await onPayload?.(...args);
          if (this.runActive) {
            this.activeRequest = { token, runId: this.requestRunId ?? "background" };
          }
          return transformed;
        },
      } as TOptions;
      return tracked;
    };
    const finish = (token: symbol) => {
      if (this.activeRequest?.token === token) this.activeRequest = undefined;
    };
    const stream = (start: (token: symbol) => AssistantMessageEventStream) => {
      const token = Symbol("provider-request");
      const result = start(token);
      void result.result().then(
        () => finish(token),
        () => finish(token),
      );
      return result;
    };
    return new Proxy(models, {
      get: (target, property) => {
        if (property === "streamSimple") {
          return (...[model, request, options]: Parameters<Models["streamSimple"]>) => {
            const over = this.runActive ? this.callOverBudgetReason() : undefined;
            if (over || this.runAborted) return abortedStream(model, over ?? "Operation aborted");
            if (this.runActive) this.tally.llmCalls += 1;
            return stream((token) => target.streamSimple(model, request, track(options, token)));
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private toHarnessTools(tools: MikanToolInput[]): MikanHarnessTool[] {
    return tools.map((tool) => (isHarnessTool(tool) ? tool : adaptAgentTool(tool)));
  }

  private async installRunTools(
    attached: AttachedSessionHarness,
    selected: MikanHarnessTool[],
  ): Promise<void> {
    const tools = [...selected];
    const deferredTools = tools.filter((tool) => tool.exposure === "deferred");
    const servers = this.sessionStore.mcpServers();
    const authorized = new Set(deferredTools.map((tool) => tool.name));
    const { harness, conversation, registry, extensionName } = attached;
    const stored = (await harness.snapshot(AgentDoc, conversation.id, context))?.tools;
    const loaded = new Set(
      Array.isArray(stored) ? stored.filter((name) => authorized.has(name)) : [],
    );
    if (tools.length > 0)
      tools.push(
        withSecretRedaction(
          createCodemodeTool({
            tools,
            servers,
            executeNested: (tool, call) => this.executeNestedTool(tool, call),
          }),
        ),
      );
    if (deferredTools.length > 0) {
      tools.push(
        withSecretRedaction(
          createToolSearchTool({
            tools: deferredTools,
            loaded,
            load: async (names) => {
              for (const name of names) if (authorized.has(name)) loaded.add(name);
            },
          }),
        ),
      );
    }
    const hasCodemode = tools.some((tool) => tool.name === "codemode");
    const registered = tools.map((tool) =>
      hasCodemode && tool.exposure === undefined && isCodemodeCallable(tool)
        ? withScriptCallNote(tool)
        : tool,
    );
    registry.install(
      defineExtension({
        name: extensionName,
        tools: registered,
        sections: [
          section("mikan", () => this.systemPrompt, { tag: false }),
          section("mcp_servers", () => renderMcpServersSection(servers) || undefined),
        ],
        hooks: [
          hook(GenerationTask, {
            beforeRequest: (_request, api) => this.beforeRequest(String(api.taskId)),
          }),
          hook(CompactionTask, {
            beforeCompact: (_compaction, api) => this.beforeCompact(String(api.taskId)),
          }),
          hook(ToolTask, {
            beforeTool: async (call, api) => this.beforeTool(call, api),
            afterTool: (call, result) => this.afterTool(call.id, result),
          }),
        ],
      }),
    );
    await conversation.configure(
      {
        model: { provider: this.model.provider, modelId: this.model.id },
        thinkingLevel: this.options.thinkingLevel,
        extensions: [registry.snapshot().extension(extensionName)!],
        tools: registered.filter((tool) => tool.exposure === undefined || loaded.has(tool.name)),
      },
      context,
    );
  }

  private beforeCompact(taskId: string): { decline: true } | undefined {
    if (!this.runActive) return undefined;
    if (this.runAborted || this.budgetExceededReason || this.callOverBudgetReason()) {
      return { decline: true };
    }
    this.tally.llmCalls += 1;
    this.activeRequest = { token: COMPACTION_REQUEST, runId: taskId };
    return undefined;
  }

  private async beforeRequest(runId: string): Promise<undefined> {
    if (!(await this.checkCallBudget())) return undefined;
    this.requestRunId = runId;
    return undefined;
  }

  private async beforeTool(
    call: { id: string; name: string; arguments: Record<string, unknown> },
    api: {
      snapshot: ToolExecutionApi["snapshot"];
      conversationId: ToolExecutionApi["conversationId"];
    },
  ): Promise<{ block?: string } | undefined> {
    const round = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools ?? [];
    if (round.length > 1 && round.some((slot) => slot.name === START_TASK_TOOL)) {
      return { block: `Call ${START_TASK_TOOL} alone, without other tools in the same batch.` };
    }
    return this.checkToolLoop(call.id, call.name, call.arguments);
  }

  private afterTool<T extends { content?: (TextContent | ImageContent)[] }>(
    callId: string,
    result: T,
  ): T | undefined {
    const notice = this.loopNotices.get(callId);
    if (notice === undefined) return undefined;
    this.loopNotices.delete(callId);
    return { ...result, content: [...(result.content ?? []), { type: "text", text: notice }] };
  }

  private async executeNestedTool(
    tool: MikanHarnessTool,
    call: Parameters<MikanHarnessTool["execute"]>,
  ): Promise<MikanToolResult> {
    const [args, api, toolContext] = call;
    const id = api.callId;
    if (this.runAborted || toolContext.abortSignal?.aborted) throw new Error("Operation aborted");
    await this.emitToolStart(id, tool.name, args);
    let result: MikanToolResult;
    try {
      const verdict = await this.checkToolLoop(id, tool.name, args as Record<string, unknown>);
      if (verdict?.block) throw new Error(verdict.block);
      toolContext.abortSignal?.throwIfAborted();
      result = await tool.execute(args, api, toolContext);
      result = this.afterTool(id, result) ?? result;
    } catch (error) {
      result = { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    } finally {
      this.loopNotices.delete(id);
    }
    await this.emitToolEnd(
      id,
      tool.name,
      { content: result.content ?? [], details: result.details },
      result.isError === true,
    );
    return result;
  }

  private async checkToolLoop(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ block: string } | undefined> {
    const verdict = this.loopGuard.observe(toolName, args);
    switch (verdict.kind) {
      case "allow":
        return undefined;
      case "notice":
        this.loopNotices.set(toolCallId, verdict.text);
        return undefined;
      case "block":
        return { block: verdict.reason };
      case "stop":
        await this.exceedBudget(verdict.reason);
        return { block: verdict.reason };
      default:
        return verdict satisfies never;
    }
  }

  private async emit(event: HarnessEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        log.logWarning("Harness event listener failed", errorMessage(error));
      }
    }
  }

  private async handleDurableEvents(events: readonly DurableEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.handleDurableEvent(event);
      } catch (error) {
        log.logWarning("Durable event handling failed", errorMessage(error));
      }
    }
    if (this.runEndSeen) this.runEnded.resolve();
  }

  private async handleDurableEvent(event: DurableEvent): Promise<void> {
    switch (event.type) {
      case "run_start":
        this.runStarted = true;
        return;
      case "run_end":
        await this.endRetry(this.runAborted ? "Retry cancelled" : undefined);
        this.runEndSeen = true;
        return;
      case "snapshot":
        return this.streamContent(event.generation?.message?.content ?? []);
      case "message_start":
        if (event.message.role === "system") return;
        this.streamingContent = [];
        await this.emit({ type: "message_start", message: event.message });
        if (event.message.role === "assistant") await this.streamContent(event.message.content);
        return;
      case "message_update":
        return this.streamContent(applyMessageChanges(this.streamingContent, event.changes));
      case "message_end":
        return this.endMessage(event.entry.model?.[0]);
      case "tool_execution_start":
        return this.emitToolStart(event.toolCallId, event.toolName, event.args);
      case "tool_execution_update":
        if (event.details === undefined) return;
        await this.emit({
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          details: event.details,
        });
        return;
      case "tool_execution_end": {
        const message = event.entry?.model?.[0];
        const toolResult = message?.role === "toolResult" ? message : undefined;
        await this.emitToolEnd(
          event.toolCallId,
          event.toolName,
          { content: toolResult?.content ?? [], details: toolResult?.details },
          toolResult?.isError ?? true,
        );
        return;
      }
      case "auto_retry_start":
        this.retryAttempt = event.attempt;
        await this.emit({
          type: "auto_retry_start",
          attempt: event.attempt,
          maxAttempts: this.settings.retry.maxRetries,
          delayMs: Math.max(0, event.at - Date.now()),
          errorMessage: event.errorMessage,
        });
        return;
      case "auto_retry_end":
        this.retryAttempt = 0;
        await this.emit({
          type: "auto_retry_end",
          attempt: event.attempt,
          success: !this.runAborted,
          finalError: this.runAborted ? "Retry cancelled" : undefined,
        });
        return;
      case "compaction_start":
        await this.emit({ type: "compaction_start", reason: event.reason });
        return;
      case "compaction_end": {
        if (this.activeRequest?.token === COMPACTION_REQUEST) this.activeRequest = undefined;
        const outcome = await this.compactionOutcome(event.taskId);
        await this.emit({
          type: "compaction_end",
          reason: event.reason,
          aborted: outcome?.status === "aborted",
          errorMessage: outcome?.status === "failed" ? outcome.error.message : undefined,
        });
        return;
      }
      case "usage_changed":
        return this.recordUsage(event.usage);
      case "task_failed":
        log.logWarning(`Durable task ${event.kind} failed`, event.message);
        return;
      default:
        return;
    }
  }

  private async streamContent(content: AssistantMessage["content"]): Promise<void> {
    const before = contentText(this.streamingContent);
    this.streamingContent = content;
    const after = contentText(content);
    if (after.length > before.length && after.startsWith(before)) {
      await this.emit({ type: "text_delta", delta: after.slice(before.length) });
    }
  }

  private async compactionOutcome(
    taskId: Parameters<AttachedSessionHarness["harness"]["getTask"]>[0],
  ) {
    const task = await this.attached?.harness.getTask(taskId, context);
    return task?.state.outcome;
  }

  private async recordUsage(state: UsageState): Promise<void> {
    const total = sumUsageState(state);
    addUsage(this.tally.usage, subtractUsage(total, this.observedUsage));
    this.observedUsage = total;
    const reason = this.resourceOverBudgetReason();
    if (reason) await this.exceedBudget(reason);
  }

  private async endRetry(finalError: string | undefined): Promise<void> {
    if (this.retryAttempt === 0) return;
    await this.emit({
      type: "auto_retry_end",
      attempt: this.retryAttempt,
      success: false,
      finalError,
    });
    this.retryAttempt = 0;
  }

  private async endMessage(message: Message | undefined): Promise<void> {
    if (!message || message.role === "system") return;
    if (message.role === "assistant") await this.streamContent(message.content);
    this.runMessages.push(message);
    await this.emit({ type: "message_end", message });
    if (message.role !== "assistant") return;
    const needsCall =
      message.stopReason === "error" || message.content.some((part) => part.type === "toolCall");
    const reason = (needsCall && this.callOverBudgetReason()) || this.resourceOverBudgetReason();
    if (reason) await this.exceedBudget(reason);
  }

  private async emitToolStart(toolCallId: string, toolName: string, args: unknown): Promise<void> {
    this.toolArgs.set(toolCallId, args);
    this.tally.toolCalls += 1;
    this.tally.toolCallCounts[toolName] = (this.tally.toolCallCounts[toolName] ?? 0) + 1;
    await this.emit({ type: "tool_execution_start", toolCallId, toolName, args });
  }

  private async emitToolEnd(
    toolCallId: string,
    toolName: string,
    result: Extract<HarnessEvent, { type: "tool_execution_end" }>["result"],
    isError: boolean,
  ): Promise<void> {
    this.toolArgs.delete(toolCallId);
    await this.emit({ type: "tool_execution_end", toolCallId, toolName, result, isError });
  }

  private async exceedBudget(reason: string): Promise<void> {
    if (this.budgetExceededReason) return;
    this.budgetExceededReason = reason;
    this.abort(reason);
    await this.emit({
      type: "budget_exceeded",
      reason,
      tokens: this.tally.usage.totalTokens,
      costUsd: this.tally.usage.cost.total,
      llmCalls: this.tally.llmCalls,
      durationMs: Date.now() - this.tally.startedAt,
    });
    log.logWarning("Run budget exceeded — aborting", reason);
  }

  private async checkCallBudget(): Promise<boolean> {
    if (this.runAborted || this.budgetExceededReason) {
      this.requestCancellation();
      return false;
    }
    const reason = this.callOverBudgetReason() ?? this.resourceOverBudgetReason();
    if (reason) await this.exceedBudget(reason);
    return !this.runAborted && !this.budgetExceededReason;
  }

  private callOverBudgetReason(): string | undefined {
    const limit = this.runBudget.maxLlmCalls;
    if (limit !== undefined && this.tally.llmCalls >= limit)
      return `${this.tally.llmCalls} LLM calls >= ${limit} limit`;
    return undefined;
  }

  private resourceOverBudgetReason(): string | undefined {
    const { maxTokens, maxCostUsd, maxDurationMs } = this.runBudget;
    if (maxTokens !== undefined && this.tally.usage.totalTokens >= maxTokens)
      return `${this.tally.usage.totalTokens} tokens >= ${maxTokens} limit`;
    if (maxCostUsd !== undefined && this.tally.usage.cost.total >= maxCostUsd)
      return `cost ${this.tally.usage.cost.total.toFixed(2)} USD >= ${maxCostUsd} USD limit`;
    if (maxDurationMs !== undefined && Date.now() - this.tally.startedAt >= maxDurationMs)
      return `${Date.now() - this.tally.startedAt}ms >= ${maxDurationMs}ms limit`;
    return undefined;
  }

  private armDeadline(): void {
    const maxDurationMs = this.runBudget.maxDurationMs;
    if (maxDurationMs === undefined || !Number.isFinite(maxDurationMs) || this.runAborted) return;
    const remaining = maxDurationMs - (Date.now() - this.tally.startedAt);
    this.deadlineTimer = setTimeout(
      () => {
        if (Date.now() - this.tally.startedAt < maxDurationMs) {
          this.armDeadline();
          return;
        }
        this.deadlineNotification = this.exceedBudget(
          `${Date.now() - this.tally.startedAt}ms >= ${maxDurationMs}ms limit`,
        );
      },
      Math.min(Math.max(0, remaining), 2_147_483_647),
    );
  }
}

function abortedAssistant(model: Model<Api>, reason: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "aborted",
    errorMessage: reason,
    timestamp: Date.now(),
  };
}

function abortedStream(model: Model<Api>, reason: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const error = abortedAssistant(model, reason);
  stream.push({ type: "error", reason: "aborted", error });
  stream.end(error);
  return stream;
}

const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {};

export const DEFAULT_EVENT_BUDGET: BudgetSettings = {
  maxDurationMs: 10 * 60 * 1000,
  maxLlmCalls: 50,
  maxCostUsd: 10,
};

function resolveHarnessSettings(overrides?: {
  compaction?: Partial<CompactionSettings>;
  retry?: Partial<RetrySettings>;
  budget?: Partial<BudgetSettings>;
}): HarnessSettings {
  return {
    compaction: { ...DEFAULT_COMPACTION_POLICY, ...overrides?.compaction },
    retry: { ...DEFAULT_RETRY_SETTINGS, ...overrides?.retry },
    budget: { ...DEFAULT_BUDGET_SETTINGS, ...overrides?.budget },
  };
}

async function contextTokens(conversation: Conversation): Promise<number> {
  const { messages } = await conversation.context(context);
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;

  if (usage.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  }
  if (usage.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }
}

export function sumUsageState(state: UsageState): Usage {
  const total = createEmptyUsage();
  for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
    addUsage(total, usage);
  }
  return total;
}

function subtractUsage(total: Usage, base: Usage): Usage {
  return {
    input: total.input - base.input,
    output: total.output - base.output,
    cacheRead: total.cacheRead - base.cacheRead,
    cacheWrite: total.cacheWrite - base.cacheWrite,
    totalTokens: total.totalTokens - base.totalTokens,
    cost: {
      input: total.cost.input - base.cost.input,
      output: total.cost.output - base.cost.output,
      cacheRead: total.cost.cacheRead - base.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite - base.cost.cacheWrite,
      total: total.cost.total - base.cost.total,
    },
    reasoning: total.reasoning === undefined ? undefined : total.reasoning - (base.reasoning ?? 0),
  };
}

export function copyUsage(usage: Usage): Usage {
  return { ...usage, cost: { ...usage.cost } };
}

function applyMessageChanges(
  content: AssistantMessage["content"],
  changes: readonly MessageChange[],
): AssistantMessage["content"] {
  const next = [...content];
  for (const change of changes) {
    switch (change.type) {
      case "message":
        next.splice(0, next.length, ...change.message.content);
        break;
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block":
        next[change.contentIndex] = change.block;
        break;
      case "text_delta": {
        const block = next[change.contentIndex];
        next[change.contentIndex] =
          block?.type === "text"
            ? { ...block, text: `${block.text}${change.delta}` }
            : { type: "text", text: change.delta };
        break;
      }
      case "thinking_delta":
      case "toolcall_delta":
        break;
      default:
        change satisfies never;
    }
  }
  return next;
}
