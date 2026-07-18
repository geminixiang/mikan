import * as log from "../log.js";
import { conversationIdOf } from "../sessions/session-key.js";
import type { ConversationRuntimeState, SessionLifecycleOptions } from "./types.js";

const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 3_600_000;

export class SessionLifecycle {
  private readonly states = new Map<string, ConversationRuntimeState>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: SessionLifecycleOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get(sessionKey: string): ConversationRuntimeState | undefined {
    return this.states.get(sessionKey);
  }

  set(sessionKey: string, state: ConversationRuntimeState): void {
    this.states.set(sessionKey, state);
  }

  async enqueue(sessionKey: string, run: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(sessionKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.queues.set(sessionKey, next);
    try {
      await next;
    } finally {
      if (this.queues.get(sessionKey) === next) this.queues.delete(sessionKey);
    }
  }

  isRunning(sessionKey: string): boolean {
    return this.states.get(sessionKey)?.running === true;
  }

  runningStates(): Array<[string, ConversationRuntimeState]> {
    return Array.from(this.states.entries()).filter(([, state]) => state.running);
  }

  conversationIds(): string[] {
    return Array.from(
      new Set(Array.from(this.states.keys(), (sessionKey) => conversationIdOf(sessionKey))),
    );
  }

  clearConversation(conversationId: string): boolean {
    for (const [sessionKey, state] of this.states) {
      if (conversationIdOf(sessionKey) === conversationId && state.running) return false;
    }
    for (const sessionKey of Array.from(this.states.keys())) {
      if (conversationIdOf(sessionKey) === conversationId) this.discard(sessionKey);
    }
    return true;
  }

  discard(sessionKey: string): void {
    const state = this.states.get(sessionKey);
    if (!state) return;
    this.states.delete(sessionKey);
    state.runner.dispose().catch((err: unknown) => {
      log.logWarning(
        `Runner dispose failed: ${sessionKey}`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  evictIdle(): void {
    const now = this.now();
    for (const [key, state] of this.states) {
      if (!state.running && now - state.lastAccessedAt > this.idleTimeoutMs) this.discard(key);
    }
    if (this.states.size <= this.maxSessions) return;

    const idle = Array.from(this.states.entries())
      .filter(([, state]) => !state.running)
      .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
    const toEvict = this.states.size - this.maxSessions;
    for (const [key] of idle.slice(0, toEvict)) this.discard(key);
  }
}
