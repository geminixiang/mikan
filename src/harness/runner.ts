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
 * - extension hook dispatch ({@link ExtensionRegistry})
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
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type CustomMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
} from "@earendil-works/pi-ai";
import * as log from "../log.js";
import type { ExtensionRegistry } from "./extensions/registry.js";
import type { MikanModels } from "./models.js";
import { resolveHarnessSettings, type BudgetSettings, type HarnessSettings } from "./settings.js";
import type { SessionStore } from "./session-store.js";
import type { CompactionEntry } from "./types.js";

export type CompactionReason = "threshold" | "overflow" | "manual";

/** Running resource tally for the current `prompt()` call, matched against the budget. */
interface RunTally {
  tokens: number;
  costUsd: number;
  llmCalls: number;
  startedAt: number;
}

interface CompactionResultSummary {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type HarnessEvent =
  | AgentEvent
  | { type: "compaction_start"; reason: CompactionReason }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      result?: CompactionResultSummary;
      aborted: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "budget_exceeded";
      /** Which cap was hit, e.g. "cost 2.01 USD > 2 USD limit". */
      reason: string;
      tokens: number;
      costUsd: number;
      llmCalls: number;
      durationMs: number;
    };

export type HarnessEventListener = (event: HarnessEvent) => void | Promise<void>;

// Transient provider failures worth retrying: overload/rate-limit responses,
// 5xx statuses, and network/stream interruptions.
const RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

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

export interface MikanAgentSessionOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  models: MikanModels;
  sessionStore: SessionStore;
  settings?: Parameters<typeof resolveHarnessSettings>[0];
  extensions?: ExtensionRegistry;
}

export class MikanAgentSession {
  readonly agent: Agent;
  readonly sessionStore: SessionStore;
  private readonly models: MikanModels;
  private readonly settings: HarnessSettings;
  private readonly extensions: ExtensionRegistry | undefined;
  private listeners = new Set<HarnessEventListener>();
  private retryAttempt = 0;
  private overflowRecoveryAttempted = false;
  private retryAbortController: AbortController | undefined;
  private compactionAbortController: AbortController | undefined;
  private tally: RunTally = { tokens: 0, costUsd: 0, llmCalls: 0, startedAt: 0 };
  private runBudget: BudgetSettings = {};
  private budgetExceededReason: string | undefined;

  constructor(options: MikanAgentSessionOptions) {
    this.models = options.models;
    this.sessionStore = options.sessionStore;
    this.settings = resolveHarnessSettings(options.settings);
    this.extensions = options.extensions;

    const tools = [...options.tools, ...(options.extensions?.getContributedTools() ?? [])];
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        tools,
      },
      convertToLlm,
      streamFn: (model, context, streamOptions) =>
        this.models.models.streamSimple(model, context, streamOptions),
      beforeToolCall: async ({ toolCall, args }) => {
        if (!this.extensions?.hasHandlers("tool_call")) return undefined;
        const result = await this.extensions.emit("tool_call", {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args,
        });
        return result ?? undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        if (this.extensions?.hasHandlers("tool_result")) {
          await this.extensions.emit("tool_result", {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args,
            content: result.content,
            isError,
          });
        }
        return undefined;
      },
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

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replace the agent transcript from the persisted session tree. */
  reloadFromSession(): number {
    const context = this.sessionStore.buildSessionContext();
    if (context.messages.length > 0) {
      this.agent.state.messages = context.messages;
    }
    return context.messages.length;
  }

  /**
   * Send a user prompt and run the agent loop to completion, including
   * automatic retries and compaction. Resolves when the turn (and any
   * recovery continuations) settles.
   *
   * @param options.budget Per-run resource ceilings that override the session
   *   defaults. Autonomous (event / trigger) runs should pass a budget so a
   *   runaway loop is stopped even with no human watching.
   */
  async prompt(
    text: string,
    options?: { images?: ImageContent[]; budget?: BudgetSettings },
  ): Promise<void> {
    if (this.agent.state.isStreaming) {
      throw new Error("Agent is already processing a prompt");
    }

    const model = this.agent.state.model;
    await this.ensureAuthConfigured(model);

    this.retryAttempt = 0;
    this.overflowRecoveryAttempted = false;
    this.runBudget = { ...this.settings.budget, ...options?.budget };
    this.budgetExceededReason = undefined;
    this.tally = { tokens: 0, costUsd: 0, llmCalls: 0, startedAt: Date.now() };

    // A previous turn may have ended over the threshold (for example after an
    // abort); compact before adding new context on top.
    const lastAssistant = this.findLastAssistantMessage();
    if (lastAssistant && lastAssistant.stopReason !== "error") {
      await this.checkThresholdCompaction(lastAssistant);
    }

    let systemPrompt = this.agent.state.systemPrompt;
    if (this.extensions?.hasHandlers("before_agent_start")) {
      const result = await this.extensions.emit("before_agent_start", {
        prompt: text,
        images: options?.images,
        systemPrompt,
      });
      if (result?.systemPrompt && result.systemPrompt !== systemPrompt) {
        // An extension rewrote the system prompt for this turn. Log the new
        // size so the diagnostic in agent.ts (which logs the pre-hook prompt)
        // isn't mistaken for the final prompt sent to the model.
        log.logInfo(
          `Extension rewrote system prompt: ${systemPrompt.length} → ${result.systemPrompt.length} chars`,
        );
        systemPrompt = result.systemPrompt;
        this.agent.state.systemPrompt = systemPrompt;
      }
    }

    const userMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text }, ...(options?.images ?? [])],
      timestamp: Date.now(),
    };

    await this.agent.prompt([userMessage]);
    while (await this.handlePostRun()) {
      await this.agent.continue();
    }

    if (this.extensions?.hasHandlers("turn_end")) {
      await this.extensions.emit("turn_end", { messages: this.agent.state.messages });
    }
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
        `No credentials for provider "${model.provider}". Set the provider API key environment variable or add it to auth.json.`,
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
    await this.emit(event);

    if (event.type !== "message_end") return;
    const message = event.message;

    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      this.sessionStore.appendMessage(message);
    } else if (message.role === "custom") {
      const custom = message as CustomMessage;
      this.sessionStore.appendCustomMessageEntry(
        custom.customType,
        custom.content,
        custom.display,
        custom.details,
      );
    }

    if (this.extensions?.hasHandlers("message_end")) {
      await this.extensions.emit("message_end", { message });
    }

    if (message.role === "assistant") {
      this.recordUsage(message);
      await this.enforceBudget();
      if (message.stopReason !== "error") {
        this.overflowRecoveryAttempted = false;
        if (this.retryAttempt > 0) {
          await this.emit({ type: "auto_retry_end", success: true, attempt: this.retryAttempt });
          this.retryAttempt = 0;
        }
      }
    }
  }

  /** Fold one assistant turn's usage into the running per-run tally. */
  private recordUsage(message: AssistantMessage): void {
    this.tally.llmCalls += 1;
    const usage = message.usage;
    if (!usage) return;
    this.tally.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    this.tally.costUsd += usage.cost?.total ?? 0;
  }

  /** Compare the tally against the run budget; abort the run when a cap is exceeded. */
  private async enforceBudget(): Promise<void> {
    if (this.budgetExceededReason) return;
    const reason = this.overBudgetReason();
    if (!reason) return;

    this.budgetExceededReason = reason;
    await this.emit({
      type: "budget_exceeded",
      reason,
      tokens: this.tally.tokens,
      costUsd: this.tally.costUsd,
      llmCalls: this.tally.llmCalls,
      durationMs: Date.now() - this.tally.startedAt,
    });
    log.logWarning("Run budget exceeded — aborting", reason);
    this.agent.abort();
  }

  private overBudgetReason(): string | undefined {
    const { maxTokens, maxCostUsd, maxDurationMs, maxLlmCalls } = this.runBudget;
    if (maxLlmCalls !== undefined && this.tally.llmCalls >= maxLlmCalls) {
      return `${this.tally.llmCalls} LLM calls >= ${maxLlmCalls} limit`;
    }
    if (maxTokens !== undefined && this.tally.tokens >= maxTokens) {
      return `${this.tally.tokens} tokens >= ${maxTokens} limit`;
    }
    if (maxCostUsd !== undefined && this.tally.costUsd >= maxCostUsd) {
      return `cost ${this.tally.costUsd.toFixed(2)} USD >= ${maxCostUsd} USD limit`;
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
      if (message.role === "assistant") return message;
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
      if (this.isRetryableError(lastAssistant)) {
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
      const pathEntries = this.sessionStore.getBranch();
      const preparation = getOrThrow(prepareCompaction(pathEntries, this.settings.compaction));
      if (!preparation) return false;

      await this.emit({ type: "compaction_start", reason });
      started = true;
      this.compactionAbortController = new AbortController();
      const signal = this.compactionAbortController.signal;

      const result = getOrThrow(
        await compact(
          preparation,
          this.models.models,
          this.agent.state.model,
          undefined,
          signal,
          this.agent.state.thinkingLevel,
        ),
      );
      if (signal.aborted) {
        await this.emit({ type: "compaction_end", reason, aborted: true });
        return false;
      }

      const entryId = this.sessionStore.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
      );
      const context = this.sessionStore.buildSessionContext();
      this.agent.state.messages = context.messages;

      if (this.extensions?.hasHandlers("session_compact")) {
        const entry = this.sessionStore.getEntry(entryId);
        if (entry?.type === "compaction") {
          await this.extensions.emit("session_compact", {
            entry: entry as CompactionEntry,
            reason,
          });
        }
      }

      await this.emit({
        type: "compaction_end",
        reason,
        result: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: result.tokensBefore,
        },
        aborted: false,
      });

      if (willRetry) {
        this.dropTrailingErrorMessage();
        return true;
      }
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

  private isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    return RETRYABLE_ERROR_PATTERN.test(message.errorMessage);
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
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      this.agent.state.messages = messages.slice(0, -1);
    }
  }
}
