/**
 * AgentSession wraps pi-agent-core's low-level `Agent` and owns the
 * turn-resilience policy pi-coding-agent used to provide automatically:
 * retry-with-backoff on transient provider errors, and auto-compaction when
 * context grows too large. Both are re-derived from pi-agent-core's exported
 * primitives (see retry-policy.ts / compaction-policy.ts) rather than
 * hand-rolled from scratch.
 *
 * Synthetic `auto_retry_start` / `compaction_start` / `compaction_end`
 * events are broadcast to subscribers in the same shape pi-coding-agent used
 * to emit them, so existing consumers (src/agent.ts's event handlers) work
 * unchanged.
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Models } from "@earendil-works/pi-ai";
import { checkCompaction } from "./compaction-policy.js";
import {
  computeBackoffDelayMs,
  DEFAULT_RETRY_SETTINGS,
  isRetryableError,
  type RetrySettings,
} from "./retry-policy.js";
import { SessionManager } from "./session-manager.js";

interface AutoRetryStartEvent {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

interface CompactionStartEvent {
  type: "compaction_start";
  reason: "overflow" | "threshold";
}

interface CompactionEndEvent {
  type: "compaction_end";
  reason: "overflow" | "threshold";
  aborted: boolean;
  result?: { tokensBefore: number };
}

export type SessionEvent =
  | AgentEvent
  | AutoRetryStartEvent
  | CompactionStartEvent
  | CompactionEndEvent;
export type SessionEventListener = (
  event: SessionEvent,
  signal: AbortSignal,
) => Promise<void> | void;

export interface AgentSessionOptions {
  models: Models;
  compactionSettings?: CompactionSettings;
  retrySettings?: RetrySettings;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Retry cancelled"));
      },
      { once: true },
    );
  });
}

export class AgentSession {
  private listeners: SessionEventListener[] = [];
  private retryAttempt = 0;
  private retryAbortController?: AbortController;
  private readonly models: Models;
  private readonly compactionSettings: CompactionSettings | undefined;
  private readonly retrySettings: RetrySettings;

  constructor(
    readonly agent: Agent,
    private readonly sessionManager: SessionManager,
    options: AgentSessionOptions,
  ) {
    this.models = options.models;
    this.compactionSettings = options.compactionSettings;
    this.retrySettings = options.retrySettings ?? DEFAULT_RETRY_SETTINGS;
    this.agent.subscribe(async (event, signal) => {
      if (event.type === "message_end") this.sessionManager.appendMessage(event.message);
      await this.emit(event, signal);
    });
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  private async emit(event: SessionEvent, signal: AbortSignal): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }

  async prompt(text: string, images?: ImageContent[] | { images?: ImageContent[] }): Promise<void> {
    await this.agent.prompt(text, Array.isArray(images) ? images : images?.images);
    while (await this.handlePostTurn()) {
      await this.agent.continue();
    }
  }

  /** Returns true if the caller should `agent.continue()` (retrying or resuming after compaction). */
  private async handlePostTurn(): Promise<boolean> {
    const messages = this.agent.state.messages;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return false;

    const contextWindow = this.agent.state.model?.contextWindow ?? 0;
    if (isRetryableError(last, contextWindow) && (await this.prepareRetry(last))) {
      return true;
    }
    if (last.stopReason !== "error") this.retryAttempt = 0;

    return this.runCompactionCheck();
  }

  private async prepareRetry(message: AssistantMessage): Promise<boolean> {
    if (!this.retrySettings.enabled) return false;
    this.retryAttempt++;
    if (this.retryAttempt > this.retrySettings.maxRetries) {
      this.retryAttempt = 0;
      return false;
    }

    const attempt = this.retryAttempt;
    const delayMs = computeBackoffDelayMs(attempt, this.retrySettings.baseDelayMs);
    const signal = new AbortController().signal;
    await this.emit(
      {
        type: "auto_retry_start",
        attempt,
        maxAttempts: this.retrySettings.maxRetries,
        delayMs,
        errorMessage: message.errorMessage || "Unknown error",
      },
      signal,
    );

    // Drop the failed attempt from live state so `agent.continue()` resumes
    // from the last good user/tool-result message; it stays in the session log.
    this.agent.state.messages = this.agent.state.messages.slice(0, -1);

    this.retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this.retryAbortController.signal);
    } catch {
      this.retryAttempt = 0;
      return false;
    } finally {
      this.retryAbortController = undefined;
    }
    return true;
  }

  private async runCompactionCheck(): Promise<boolean> {
    let startedReason: "overflow" | "threshold" | undefined;
    const signal = new AbortController().signal;
    const outcome = await checkCompaction(
      this.agent,
      this.sessionManager,
      this.models,
      this.compactionSettings,
      async (reason) => {
        startedReason = reason;
        await this.emit({ type: "compaction_start", reason }, signal);
      },
    );
    if (!startedReason) return false;

    await this.emit(
      {
        type: "compaction_end",
        reason: startedReason,
        aborted: !outcome.compacted,
        result: outcome.result ? { tokensBefore: outcome.result.tokensBefore } : undefined,
      },
      signal,
    );
    // Overflow compaction removed the errored turn from context; resume it.
    // Threshold compaction just trims history — the current turn already finished.
    return outcome.compacted && startedReason === "overflow";
  }

  abort(): void {
    this.retryAbortController?.abort();
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }
}
