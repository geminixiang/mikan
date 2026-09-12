import {
  TODO_CONTEXT,
  OperationMismatch,
  getOrThrow,
  type AgentHarness,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
  type AgentTool,
  type HarnessEvent as PiHarnessEvent,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Api, Usage } from "@earendil-works/pi-ai";
import type { SessionStore } from "./session-store.js";
import type {
  BudgetSettings,
  HarnessEvent,
  HarnessEventListener,
  HarnessSettings,
  MikanAgentSessionOptions,
  SubagentUsage,
  SubagentUsageSink,
  RetrySettings,
} from "./types.js";

import * as log from "../log.js";

export type { CompactionReason } from "./types.js";
export type { HarnessEvent } from "./types.js";
export type { HarnessEventListener } from "./types.js";
export type { MikanAgentSessionOptions } from "./types.js";

interface RunTally {
  usage: SubagentUsage;
  llmCalls: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  startedAt: number;
  endedAt?: number;
}

const FORWARDED_EVENTS = [
  "run_start",
  "run_end",
  "message_start",
  "message_update",
  "entry_added",
  "turn_start",
  "turn_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "retry_scheduled",
  "retry_end",
  "compaction_start",
  "compaction_end",
  "usage",
  "fault",
] as const;

export class MikanAgentSession {
  readonly sessionStore: SessionStore;
  readonly model: Model<Api>;
  private readonly settings: HarnessSettings;
  private readonly listeners = new Set<HarnessEventListener>();
  private systemPrompt: string;
  private transcript: AgentMessage[] = [];
  private harness: AgentHarness | undefined;
  private lane: AgentLane | undefined;
  private runActive = false;
  private runAborted = false;
  private operationId: string | undefined;
  private cancellation: Promise<void> | undefined;
  private cancellationError: unknown;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineNotification: Promise<void> | undefined;
  private runBudget: BudgetSettings = {};
  private budgetExceededReason: string | undefined;
  private retryAttempt = 0;
  private latestAssistantNeedsCall = false;
  private latestAssistantErrored = false;
  private runMessages: AgentMessage[] = [];
  private readonly toolArgs = new Map<string, unknown>();
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

  get messages(): AgentMessage[] {
    return this.transcript;
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
      ...(this.budgetExceededReason ? { budgetExceededReason: this.budgetExceededReason } : {}),
    };
  }

  /** Bind delegated spend to its owning prompt, even when cleanup finishes late. */
  captureExternalUsageSink(): SubagentUsageSink {
    const tally = this.tally;
    return async (usage) => {
      addUsage(tally.usage, usage);
      if (this.tally !== tally || !this.runActive || this.budgetExceededReason) return;
      const reason = this.resourceOverBudgetReason();
      if (reason) await this.exceedBudget(reason);
    };
  }

  async foldExternalUsage(usage: SubagentUsage): Promise<void> {
    await this.captureExternalUsageSink()(usage);
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reloadFromSession(): Promise<number> {
    this.transcript = (await this.sessionStore.buildSessionContext()).messages;
    return this.transcript.length;
  }

  async prompt(
    text: string,
    options?: {
      images?: ImageContent[];
      budget?: BudgetSettings;
      tools?: AgentTool[];
    },
  ): Promise<void> {
    await this.run(text, options);
  }

  /** Resume an operation left open by a previous process using Pi's recovery rules. */
  async resume(options?: { budget?: BudgetSettings; tools?: AgentTool[] }): Promise<void> {
    await this.run(undefined, options);
  }

  private async run(
    text: string | undefined,
    options?: {
      images?: ImageContent[];
      budget?: BudgetSettings;
      tools?: AgentTool[];
    },
  ): Promise<void> {
    if (this.runActive) throw new Error("Agent is already processing a prompt");
    this.runActive = true;
    this.runAborted = false;
    this.budgetExceededReason = undefined;
    this.cancellationError = undefined;
    this.retryAttempt = 0;
    this.latestAssistantNeedsCall = false;
    this.latestAssistantErrored = false;
    this.runMessages = [];
    this.runBudget = { ...this.settings.budget, ...options?.budget };
    this.tally = {
      usage: createEmptyUsage(),
      llmCalls: 0,
      toolCalls: 0,
      toolCallCounts: {},
      startedAt: Date.now(),
    };
    let runFailure: { error: unknown } | undefined;
    try {
      if (!(await this.checkCallBudget())) return;
      this.armDeadline();
      const auth = await this.options.models.getAuth(this.model);
      if (this.runAborted) return;
      if (!auth)
        throw new Error(
          `No credentials for provider "${this.model.provider}". Set the provider API key environment variable.`,
        );
      await this.initialize();
      if (this.runAborted) return;
      const harness = this.harness!;
      const lane = this.lane!;
      const tools = options?.tools ?? this.options.tools;
      await harness.setTools(this.nativeTools(tools), TODO_CONTEXT);
      await lane.setActiveTools(
        tools.map((tool) => tool.name),
        TODO_CONTEXT,
      );
      await this.reloadFromSession();
      if (!(await this.checkCallBudget())) return;
      await this.driveOperation(lane, text, options?.images);
    } catch (error) {
      runFailure = { error };
      throw error;
    } finally {
      await this.cleanupRun(runFailure);
    }
  }

  private async driveOperation(
    lane: AgentLane,
    text: string | undefined,
    images?: ImageContent[],
  ): Promise<void> {
    if (text === undefined) {
      const current = await lane.inspectExecution(TODO_CONTEXT);
      this.operationId = current.current?.id;
      if (this.runAborted) this.requestCancellation();
      const result = getOrThrow(await lane.resume(TODO_CONTEXT));
      if (result.status === "failed") throw new Error(result.error?.message ?? "Pi run failed");
      return;
    }
    // Pi owns admission, retries, compaction, persistence, and the tool loop.
    const admission = getOrThrow(
      await lane.accept({ kind: "prompt", prompt: text, images }, TODO_CONTEXT),
    );
    this.operationId = admission.operationId;
    if (this.runAborted) this.requestCancellation();
    const result = getOrThrow(
      await lane.drive({ operationId: admission.operationId, waitForRetry: true }, TODO_CONTEXT),
    );
    // The assistant error is already persisted and presented when present.
    if (
      result.kind === "settled" &&
      result.outcome.status === "failed" &&
      !this.latestAssistantErrored
    ) {
      throw new Error(result.outcome.error?.message ?? "Pi run failed");
    }
  }

  private async cleanupRun(runFailure: { error: unknown } | undefined): Promise<void> {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await this.cancellation;
      await this.deadlineNotification;
      if (this.cancellationError) throw this.cancellationError;
    } catch (error) {
      cleanupFailure = { error };
    } finally {
      this.toolArgs.clear();
      this.operationId = undefined;
      this.cancellation = undefined;
      this.deadlineNotification = undefined;
      this.tally.endedAt = Date.now();
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

  /** Pi's durable cancellation gate stops providers, tools, retries, and summaries. */
  abort(): void {
    if (!this.runActive) return;
    this.runAborted = true;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.requestCancellation();
  }

  private requestCancellation(): void {
    if (!this.lane || !this.operationId || this.cancellation) return;
    // Do not await a lane mutation inside an event listener: Pi serializes event
    // delivery, and the abort mutation itself emits another event. The native
    // gate closes synchronously; prompt() drains the mutation before releasing ownership.
    this.cancellation = this.lane
      .requestAbort(this.operationId, TODO_CONTEXT)
      .then((result) => {
        if (!result.ok && !(result.error instanceof OperationMismatch)) throw result.error;
      })
      .catch((error: unknown) => {
        this.cancellationError = error;
      });
  }

  private nativeTools(tools: AgentTool[]): AgentHarnessTool<object | undefined>[] {
    return tools.map((tool) => ({
      ...tool,
      execute: (
        ...[id, params, onUpdate, , , context]: Parameters<
          AgentHarnessTool<object | undefined>["execute"]
        >
      ) => tool.execute(id, params, context.abortSignal, onUpdate),
    }));
  }

  private async initialize(): Promise<void> {
    if (this.harness) return;
    this.harness = await this.sessionStore.createHarness({
      models: this.options.models.models,
      model: this.model,
      thinkingLevel: this.options.thinkingLevel,
      tools: this.nativeTools(this.options.tools),
      systemPrompt: () => this.sessionStore.withMcpInstructions(this.systemPrompt),
      retry: this.settings.retry,
      compaction: this.settings.compaction,
    });
    this.lane = await this.harness.lane("main", TODO_CONTEXT);
    // Restored lanes retain their old configuration; the runtime's selected
    // model and thinking level apply to this session wrapper.
    await this.lane.setModel(
      { provider: this.model.provider, modelId: this.model.id },
      TODO_CONTEXT,
    );
    await this.lane.setThinkingLevel(this.options.thinkingLevel, TODO_CONTEXT);
    this.harness.hooks.on("before_request", async () => {
      if (!(await this.checkCallBudget())) return undefined;
      this.tally.llmCalls += 1;
      return undefined;
    });
    for (const type of FORWARDED_EVENTS) {
      this.harness.events.on(type, (event) => this.handlePiEvent(event));
    }
  }

  private async emit(event: HarnessEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        log.logWarning(
          "Harness event listener failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private async handlePiEvent(event: PiHarnessEvent): Promise<void> {
    if (!this.runActive) return;
    if ("lane" in event && event.lane !== undefined && event.lane !== "main") return;
    switch (event.type) {
      case "entry_added":
        if (event.entry.type !== "message") return;
        this.transcript.push(event.entry.message);
        this.runMessages.push(event.entry.message);
        if (event.entry.message.role === "assistant") {
          const message = event.entry.message;
          this.latestAssistantErrored = message.stopReason === "error";
          this.latestAssistantNeedsCall =
            message.stopReason === "error" ||
            message.content.some((part) => part.type === "toolCall");
        }
        await this.emit({ type: "message_end", message: event.entry.message });
        return;
      case "message_start":
        await this.emit({ type: "message_start", message: event.message });
        return;
      case "message_update":
        await this.emit({
          type: "message_update",
          message: event.message,
          assistantMessageEvent: event.event,
        });
        return;
      case "turn_start":
        await this.emit({ type: "turn_start" });
        return;
      case "turn_end":
        await this.emit({
          type: "turn_end",
          message: event.message,
          toolResults: event.toolResults,
        });
        return;
      case "tool_start":
      case "tool_update":
      case "tool_end":
        return this.handlePiToolEvent(event);
      case "usage":
        return this.recordUsage(event.row.usage);
      case "run_start":
      case "run_end":
      case "retry_scheduled":
      case "retry_end":
      case "compaction_start":
      case "compaction_end":
        return this.handlePiLifecycleEvent(event);
      case "fault":
        throw new Error(event.message);
    }
  }

  private async recordUsage(usage: SubagentUsage): Promise<void> {
    addUsage(this.tally.usage, usage);
    const reason =
      (this.latestAssistantNeedsCall && this.callOverBudgetReason()) ||
      this.resourceOverBudgetReason();
    if (reason) await this.exceedBudget(reason);
  }

  private async handlePiToolEvent(
    event: Extract<PiHarnessEvent, { type: "tool_start" | "tool_update" | "tool_end" }>,
  ): Promise<void> {
    switch (event.type) {
      case "tool_start":
        this.toolArgs.set(event.toolCallId, event.args);
        this.tally.toolCalls += 1;
        this.tally.toolCallCounts[event.toolName] =
          (this.tally.toolCallCounts[event.toolName] ?? 0) + 1;
        await this.emit({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        return;
      case "tool_update":
        await this.emit({
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: this.toolArgs.get(event.toolCallId) ?? {},
          partialResult: event.partialResult,
        });
        return;
      case "tool_end":
        this.toolArgs.delete(event.toolCallId);
        await this.emit({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        return;
    }
  }

  private async handlePiLifecycleEvent(
    event: Extract<
      PiHarnessEvent,
      {
        type:
          | "run_start"
          | "run_end"
          | "retry_scheduled"
          | "retry_end"
          | "compaction_start"
          | "compaction_end";
      }
    >,
  ): Promise<void> {
    switch (event.type) {
      case "run_start":
        this.operationId = event.runId;
        if (this.runAborted) this.requestCancellation();
        await this.emit({ type: "agent_start" });
        return;
      case "retry_scheduled":
        this.retryAttempt = event.attempt - 1;
        await this.emit({
          type: "auto_retry_start",
          attempt: this.retryAttempt,
          maxAttempts: event.maxAttempts - 1,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        });
        return;
      case "retry_end":
        this.retryAttempt = 0;
        await this.emit({
          type: "auto_retry_end",
          attempt: event.attempt - 1,
          success: event.success,
          finalError: event.finalError,
        });
        return;
      case "compaction_start":
        await this.emit({ type: "compaction_start", reason: event.reason });
        return;
      case "compaction_end": {
        const entry =
          event.status === "completed"
            ? await this.sessionStore.getEntry(event.entryId)
            : undefined;
        if (entry?.type === "compaction") await this.reloadFromSession();
        await this.emit({
          type: "compaction_end",
          reason: event.reason,
          aborted: event.status === "aborted",
          ...(event.status === "failed" ? { errorMessage: event.error.message } : {}),
          ...(entry?.type === "compaction"
            ? {
                result: {
                  summary: entry.summary,
                  retainedMessages: entry.retainedTail.length,
                  tokensBefore: entry.tokensBefore,
                },
              }
            : {}),
        });
        return;
      }
      case "run_end":
        if (this.retryAttempt > 0) {
          await this.emit({
            type: "auto_retry_end",
            attempt: this.retryAttempt,
            success: false,
            finalError: event.status === "aborted" ? "Retry cancelled" : event.error?.message,
          });
          this.retryAttempt = 0;
        }
        await this.emit({ type: "agent_end", messages: this.runMessages });
        return;
    }
  }

  private async exceedBudget(reason: string): Promise<void> {
    if (this.budgetExceededReason) return;
    this.budgetExceededReason = reason;
    this.abort();
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

export type { CompactionSettings };
export type { BudgetSettings } from "./types.js";
export type { HarnessSettings } from "./types.js";
export type { RetrySettings } from "./types.js";

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

/**
 * Per-run resource ceilings — the harness's external circuit breakers.
 *
 * An LLM cannot reliably decide on its own when to stop (the halting problem),
 * so a runaway run has to be stopped from the outside. When any populated cap
 * is exceeded, the run is aborted and a `budget_exceeded` event is emitted.
 * Every field is a cap on a single `prompt()` call; an undefined field means
 * "no cap on that axis". Interactive runs are gated turn-by-turn by a human,
 * so they default to uncapped; autonomous runs (scheduled events, triggers)
 * pass {@link DEFAULT_EVENT_BUDGET}, where nobody is watching the loop.
 */
/** Interactive runs are human-gated per turn — no automatic ceiling by default. */
export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {};

/**
 * Ceiling for autonomous (event / trigger) runs, where no human is watching
 * the loop. Deliberately generous — it is a stop-loss, not a target.
 */
export const DEFAULT_EVENT_BUDGET: BudgetSettings = {
  maxDurationMs: 10 * 60 * 1000,
  maxLlmCalls: 50,
  maxCostUsd: 10,
};

export function resolveHarnessSettings(overrides?: {
  compaction?: Partial<CompactionSettings>;
  retry?: Partial<RetrySettings>;
  budget?: Partial<BudgetSettings>;
}): HarnessSettings {
  return {
    compaction: { ...DEFAULT_COMPACTION_SETTINGS, ...overrides?.compaction },
    retry: { ...DEFAULT_RETRY_SETTINGS, ...overrides?.retry },
    budget: { ...DEFAULT_BUDGET_SETTINGS, ...overrides?.budget },
  };
}

/**
 * Harness-wide usage accounting: parent-session assistant turns, compaction
 * completions, and subagent folds all accumulate through these helpers.
 * `SubagentUsage` (public surface) is an alias of pi-ai's `Usage`; the
 * aggregation rules here are not subagent-specific.
 */

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

function addUsage(total: Usage, usage: Usage): void {
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

export function copyUsage(usage: Usage): Usage {
  return { ...usage, cost: { ...usage.cost } };
}
