/**
 * MikanAgentSession — mikan's agent run loop.
 *
 * Owns a pi-agent-core `Agent` and layers on the behaviors mikan needs for
 * long-lived chat conversations:
 *
 * - message persistence into the conversation's {@link SessionStore}
 * - automatic context compaction (threshold and overflow recovery), using
 *   pi-agent-core's compaction pipeline over the session tree
 * - automatic retry with exponential backoff on transient provider errors
 *
 * Events mirror the agent's lifecycle events plus `compaction_start/_end`
 * and `auto_retry_start/_end`, preserving the event surface mikan's
 * platform adapters already render.
 */
import {
  Agent,
  calculateContextTokens,
  compact,
  convertToLlm,
  estimateContextTokens,
  getOrThrow,
  prepareCompaction,
  shouldCompact,
  TODO_CONTEXT,
  withAbortSignal,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type CustomMessage,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import * as log from "../log.js";
import type { MikanModels } from "./models.js";
import { resolveHarnessSettings } from "./settings.js";
import type { SessionStore } from "./session-store.js";
import type {
  BudgetSettings,
  CompactionReason,
  HarnessEvent,
  HarnessEventListener,
  HarnessSettings,
  MikanAgentSessionOptions,
  SubagentUsage,
  SubagentUsageSink,
} from "./types.js";

export type {
  CompactionReason,
  HarnessEvent,
  HarnessEventListener,
  MikanAgentSessionOptions,
} from "./types.js";
import { addUsage, copyUsage, createEmptyUsage } from "./usage.js";

/** Running resource tally for the current `prompt()` call, matched against the budget. */
interface RunTally {
  usage: SubagentUsage;
  llmCalls: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  startedAt: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class MikanAgentSession {
  readonly agent: Agent;
  readonly sessionStore: SessionStore;
  private readonly models: MikanModels;
  private readonly settings: HarnessSettings;
  private listeners = new Set<HarnessEventListener>();
  private retryAttempt = 0;
  private overflowRecoveryAttempted = false;
  private retryAbortController: AbortController | undefined;
  private compactionAbortController: AbortController | undefined;
  private runActive = false;
  private tally: RunTally = {
    usage: createEmptyUsage(),
    llmCalls: 0,
    toolCalls: 0,
    toolCallCounts: {},
    startedAt: 0,
  };
  private runBudget: BudgetSettings = {};
  private budgetExceededReason: string | undefined;

  constructor(options: MikanAgentSessionOptions) {
    this.models = options.models;
    this.sessionStore = options.sessionStore;
    this.settings = resolveHarnessSettings(options.settings);

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        tools: options.tools,
      },
      convertToLlm,
      streamFn: (model, context, streamOptions) =>
        this.models.models.streamSimple(model, context, streamOptions),
    });

    this.agent.subscribe(async (event) => {
      await this.handleAgentEvent(event);
    });
  }

  /** Conversation transcript currently held by the agent. */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get model(): Model<Api> {
    return this.agent.state.model;
  }

  /** Whether this session currently owns a prompt, including pre-model hooks. */
  get isActiveRun(): boolean {
    return this.runActive;
  }

  /** Resource totals and terminal budget state from the most recent prompt. */
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
      durationMs: this.tally.startedAt > 0 ? Date.now() - this.tally.startedAt : 0,
      ...(this.budgetExceededReason ? { budgetExceededReason: this.budgetExceededReason } : {}),
    };
  }

  /**
   * Fold spend incurred outside this session's own LLM calls — e.g. subagent
   * runs launched by a tool during the current prompt — into the run tally
   * and enforce the run budget at the fold itself: a fold that lands over a
   * resource ceiling aborts the run now instead of waiting for a next
   * assistant message that may never come (and would be paid for). Complete
   * usage is folded; external runs are not this session's turns.
   */
  /** Capture a usage sink bound to the tally owned by the current prompt run. */
  captureExternalUsageSink(): SubagentUsageSink {
    const tally = this.tally;
    return async (usage) => {
      addUsage(tally.usage, usage);
      if (this.tally !== tally || this.budgetExceededReason || !this.runActive) return;
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

  /** Replace the agent transcript from the persisted session tree. */
  async reloadFromSession(): Promise<number> {
    const context = await this.sessionStore.buildSessionContext();
    if (context.messages.length > 0) {
      this.agent.state.messages = context.messages;
    }
    return context.messages.length;
  }

  /**
   * Send a user prompt and run the agent loop to completion, including
   * automatic retries and compaction.
   *
   * @param options.budget Per-run resource ceilings that override the session
   *   defaults. Autonomous event runs should pass a budget so a runaway loop
   *   is stopped even with no human watching.
   */
  async prompt(
    text: string,
    options?: {
      images?: ImageContent[];
      budget?: BudgetSettings;
      tools?: AgentTool[];
    },
  ): Promise<void> {
    if (this.runActive) throw new Error("Agent is already processing a prompt");
    this.runActive = true;
    const runSystemPrompt = this.agent.state.systemPrompt;
    const runTools = this.agent.state.tools;
    if (options?.tools) this.agent.state.tools = options.tools;
    try {
      await this.runPrompt(text, options);
    } finally {
      this.agent.state.systemPrompt = runSystemPrompt;
      this.agent.state.tools = runTools;
      this.runActive = false;
    }
  }

  private async runPrompt(
    text: string,
    options?: {
      images?: ImageContent[];
      budget?: BudgetSettings;
      tools?: AgentTool[];
    },
  ): Promise<void> {
    this.retryAttempt = 0;
    this.overflowRecoveryAttempted = false;
    this.runBudget = { ...this.settings.budget, ...options?.budget };
    this.budgetExceededReason = undefined;
    this.tally = {
      usage: createEmptyUsage(),
      llmCalls: 0,
      toolCalls: 0,
      toolCallCounts: {},
      startedAt: Date.now(),
    };

    await this.ensureAuthConfigured(this.agent.state.model);

    // A previous turn may have ended over the threshold (for example after an
    // abort); compact before adding new context on top.
    const lastAssistant = this.findLastAssistantMessage();
    if (lastAssistant && lastAssistant.stopReason !== "error") {
      await this.checkThresholdCompaction(lastAssistant);
    }

    const userMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text }, ...(options?.images ?? [])],
      timestamp: Date.now(),
    };

    await this.agent.prompt([userMessage]);
    while (await this.handlePostRun()) await this.agent.continue();
  }

  /** Abort the active run, pending retry backoff, and in-flight compaction. */
  abort(): void {
    this.retryAbortController?.abort();
    this.compactionAbortController?.abort();
    this.agent.abort();
  }

  private async ensureAuthConfigured(model: Model<Api>): Promise<void> {
    const auth = await this.models.getAuth(model);
    if (!auth) {
      throw new Error(
        `No credentials for provider "${model.provider}". Set the provider API key environment variable.`,
      );
    }
  }

  private async emit(event: HarnessEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        log.logWarning(
          "Harness event listener failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === "tool_execution_start") {
      this.tally.toolCalls += 1;
      this.tally.toolCallCounts[event.toolName] =
        (this.tally.toolCallCounts[event.toolName] ?? 0) + 1;
    }
    if (event.type !== "message_end") {
      await this.emit(event);
      return;
    }

    const message = event.message;
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      await this.sessionStore.appendMessage(message);
    } else if (message.role === "custom") {
      const custom = message as CustomMessage;
      await this.sessionStore.appendCustomMessageEntry(
        custom.customType,
        custom.content,
        custom.display,
        custom.details,
      );
    }

    await this.emit({ ...event, message });

    if (message.role === "assistant") {
      this.recordUsage(message);
      await this.enforceBudget(message);
      if (message.stopReason !== "error") {
        this.overflowRecoveryAttempted = false;
        if (this.retryAttempt > 0) {
          await this.emit({ type: "auto_retry_end", success: true, attempt: this.retryAttempt });
          this.retryAttempt = 0;
        }
      }
    }
  }

  /** Fold one assistant completion's usage into the running per-run tally. */
  private recordUsage(message: AssistantMessage): void {
    this.tally.llmCalls += 1;
    const usage = message.usage;
    if (!usage) return;
    addUsage(this.tally.usage, usage);
  }

  /** Compare the tally against the run budget; abort the run when a cap is exceeded. */
  private async enforceBudget(message: AssistantMessage): Promise<void> {
    if (this.budgetExceededReason) return;
    const reason = this.overBudgetReason(message);
    if (!reason) return;
    await this.exceedBudget(reason);
  }

  /** Mark the run over budget, notify listeners, and abort the agent. */
  private async exceedBudget(reason: string): Promise<void> {
    if (this.budgetExceededReason) return;
    this.budgetExceededReason = reason;
    await this.emit({
      type: "budget_exceeded",
      reason,
      tokens: this.tally.usage.totalTokens,
      costUsd: this.tally.usage.cost.total,
      llmCalls: this.tally.llmCalls,
      durationMs: Date.now() - this.tally.startedAt,
    });
    log.logWarning("Run budget exceeded — aborting", reason);
    this.agent.abort();
  }

  private overBudgetReason(message: AssistantMessage): string | undefined {
    const { maxLlmCalls } = this.runBudget;
    const needsAnotherCall =
      message.stopReason === "error" || message.content.some((part) => part.type === "toolCall");
    if (needsAnotherCall && maxLlmCalls !== undefined && this.tally.llmCalls >= maxLlmCalls) {
      return `${this.tally.llmCalls} LLM calls >= ${maxLlmCalls} limit`;
    }
    return this.resourceOverBudgetReason();
  }

  /** The message-independent budget checks, shared with external-spend folds. */
  private resourceOverBudgetReason(): string | undefined {
    const { maxTokens, maxCostUsd, maxDurationMs } = this.runBudget;
    if (maxTokens !== undefined && this.tally.usage.totalTokens >= maxTokens) {
      return `${this.tally.usage.totalTokens} tokens >= ${maxTokens} limit`;
    }
    if (maxCostUsd !== undefined && this.tally.usage.cost.total >= maxCostUsd) {
      return `cost ${this.tally.usage.cost.total.toFixed(2)} USD >= ${maxCostUsd} USD limit`;
    }
    if (maxDurationMs !== undefined && Date.now() - this.tally.startedAt >= maxDurationMs) {
      return `${Date.now() - this.tally.startedAt}ms >= ${maxDurationMs}ms limit`;
    }
    return undefined;
  }

  private findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "assistant") return message;
    }
    return undefined;
  }

  /** Decide what to do after a run settles. Returns true when the agent should continue. */
  private async handlePostRun(): Promise<boolean> {
    // A run stopped for going over budget must not be retried or compacted back
    // into another continuation — that would defeat the circuit breaker.
    if (this.budgetExceededReason) return false;

    const lastAssistant = this.findLastAssistantMessage();
    if (!lastAssistant) return false;

    if (lastAssistant.stopReason === "error") {
      const contextWindow = this.agent.state.model.contextWindow || 0;
      if (isContextOverflow(lastAssistant, contextWindow)) {
        return this.handleOverflow();
      }
      if (isRetryableAssistantError(lastAssistant)) {
        return this.prepareRetry(lastAssistant);
      }
      return false;
    }

    return this.checkThresholdCompaction(lastAssistant);
  }

  private async handleOverflow(): Promise<boolean> {
    if (this.overflowRecoveryAttempted) {
      await this.emit({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        errorMessage:
          "Context overflow recovery failed after one compact-and-retry attempt. Try /new or a larger-context model.",
      });
      return false;
    }
    this.overflowRecoveryAttempted = true;
    this.dropTrailingErrorMessage();
    return this.runCompaction("overflow", true);
  }

  private async checkThresholdCompaction(lastAssistant: AssistantMessage): Promise<boolean> {
    const settings = this.settings.compaction;
    if (!settings.enabled) return false;
    const contextWindow = this.agent.state.model.contextWindow || 0;
    if (contextWindow <= 0) return false;

    let contextTokens = lastAssistant.usage ? calculateContextTokens(lastAssistant.usage) : 0;
    if (contextTokens === 0) {
      const estimate = estimateContextTokens(this.agent.state.messages);
      if (estimate.lastUsageIndex === null) return false;
      contextTokens = estimate.tokens;
    }

    if (!shouldCompact(contextTokens, contextWindow, settings)) return false;
    return this.runCompaction("threshold", false);
  }

  private async runCompaction(reason: CompactionReason, willRetry: boolean): Promise<boolean> {
    let started = false;
    try {
      const pathEntries = await this.sessionStore.getBranch();
      const preparation = getOrThrow(prepareCompaction(pathEntries, this.settings.compaction));
      if (!preparation) return false;

      await this.emit({ type: "compaction_start", reason });
      started = true;
      this.compactionAbortController = new AbortController();
      const signal = this.compactionAbortController.signal;

      const result = getOrThrow(
        await compact(
          preparation,
          this.createCompactionModels(),
          this.agent.state.model,
          undefined,
          this.agent.state.thinkingLevel,
          undefined,
          undefined,
          withAbortSignal(signal, TODO_CONTEXT),
        ),
      );
      if (signal.aborted) {
        await this.emit({ type: "compaction_end", reason, aborted: true });
        return false;
      }
      await this.sessionStore.appendCompaction(
        result.summary,
        result.retainedTail,
        result.tokensBefore,
        result.details,
      );
      const context = await this.sessionStore.buildSessionContext();
      this.agent.state.messages = context.messages;

      await this.emit({
        type: "compaction_end",
        reason,
        result: {
          summary: result.summary,
          retainedMessages: result.retainedTail.length,
          tokensBefore: result.tokensBefore,
        },
        aborted: false,
      });

      if (this.budgetExceededReason) return false;
      // Messages here were just rebuilt from the store, which already filters
      // error assistants out of context — nothing left for the drop to target.
      if (willRetry) return true;
      return this.agent.hasQueuedMessages();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "compaction failed";
      if (started) {
        await this.emit({
          type: "compaction_end",
          reason,
          aborted: false,
          errorMessage:
            reason === "overflow"
              ? `Context overflow recovery failed: ${errorMessage}`
              : `Auto-compaction failed: ${errorMessage}`,
        });
      } else {
        log.logWarning("Compaction preparation failed", errorMessage);
      }
      return false;
    } finally {
      this.compactionAbortController = undefined;
    }
  }

  /**
   * Compaction can make one completion, or two when its cut splits a turn.
   * Intercept only those opaque upstream calls so each returned assistant
   * message is tallied exactly once. A call at maxLlmCalls is not started;
   * the cap is otherwise enforced before any post-compaction continuation.
   */
  private createCompactionModels(): Models {
    const models = this.models.models;
    return new Proxy(models, {
      get: (target, property) => {
        if (property === "completeSimple") {
          return async (...args: Parameters<Models["completeSimple"]>) => {
            const maxLlmCalls = this.runBudget.maxLlmCalls;
            if (maxLlmCalls !== undefined && this.tally.llmCalls >= maxLlmCalls) {
              await this.exceedBudget(`${this.tally.llmCalls} LLM calls >= ${maxLlmCalls} limit`);
              throw new Error("Compaction LLM-call budget exhausted");
            }

            const message = await target.completeSimple(...args);
            this.recordUsage(message);
            const reason = this.resourceOverBudgetReason();
            if (reason) await this.exceedBudget(reason);
            return message;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private async prepareRetry(message: AssistantMessage): Promise<boolean> {
    const settings = this.settings.retry;
    if (!settings.enabled) return false;

    this.retryAttempt++;
    if (this.retryAttempt > settings.maxRetries) {
      this.retryAttempt--;
      await this.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this.retryAttempt,
        finalError: message.errorMessage,
      });
      this.retryAttempt = 0;
      return false;
    }

    const delayMs = settings.baseDelayMs * 2 ** (this.retryAttempt - 1);
    await this.emit({
      type: "auto_retry_start",
      attempt: this.retryAttempt,
      maxAttempts: settings.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error",
    });

    this.dropTrailingErrorMessage();

    this.retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this.retryAbortController.signal);
    } catch {
      const attempt = this.retryAttempt;
      this.retryAttempt = 0;
      await this.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      });
      return false;
    } finally {
      this.retryAbortController = undefined;
    }
    return true;
  }

  private dropTrailingErrorMessage(): void {
    const messages = this.agent.state.messages;
    if (messages[messages.length - 1]?.role === "assistant") {
      this.agent.state.messages = messages.slice(0, -1);
    }
  }
}
