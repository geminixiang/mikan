import * as log from "../log.js";
import { conversationIdOf } from "../sessions/session-key.js";
import type { ConversationRuntimeState, SessionLifecycleOptions } from "./types.js";

const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 3_600_000;

interface ConversationBarrier {
  activeWork: number;
  pendingMaintenance: number;
  maintenanceTail: Promise<void>;
  activeWaiters: Array<() => void>;
  workWaiters: Array<() => void>;
}

export class SessionLifecycle {
  private readonly states = new Map<string, ConversationRuntimeState>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly conversationBarriers = new Map<string, ConversationBarrier>();
  private readonly pendingConversationClears = new Set<string>();
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

  async acquireConversationWork(conversationId: string): Promise<() => void> {
    const barrier = this.getConversationBarrier(conversationId);
    while (barrier.pendingMaintenance > 0) {
      await new Promise<void>((resolve) => barrier.workWaiters.push(resolve));
    }

    barrier.activeWork++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      barrier.activeWork--;
      if (barrier.activeWork === 0) {
        const waiters = barrier.activeWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    };
  }

  async runConversationMaintenance<T>(
    conversationId: string,
    maintenance: () => Promise<T>,
  ): Promise<T> {
    const barrier = this.getConversationBarrier(conversationId);
    barrier.pendingMaintenance++;

    const previousMaintenance = barrier.maintenanceTail;
    let finishMaintenance!: () => void;
    const maintenanceTurn = new Promise<void>((resolve) => (finishMaintenance = resolve));
    barrier.maintenanceTail = previousMaintenance.then(() => maintenanceTurn);

    await previousMaintenance;
    if (barrier.activeWork > 0) {
      await new Promise<void>((resolve) => barrier.activeWaiters.push(resolve));
    }

    try {
      return await maintenance();
    } finally {
      finishMaintenance();
      barrier.pendingMaintenance--;
      if (barrier.pendingMaintenance === 0) {
        const waiters = barrier.workWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private getConversationBarrier(conversationId: string): ConversationBarrier {
    const existing = this.conversationBarriers.get(conversationId);
    if (existing) return existing;

    const barrier: ConversationBarrier = {
      activeWork: 0,
      pendingMaintenance: 0,
      maintenanceTail: Promise.resolve(),
      activeWaiters: [],
      workWaiters: [],
    };
    this.conversationBarriers.set(conversationId, barrier);
    return barrier;
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
    if (this.hasActiveRun(conversationId)) return false;
    this.pendingConversationClears.delete(conversationId);
    this.discardConversation(conversationId);
    return true;
  }

  deferConversationClear(conversationId: string): void {
    this.pendingConversationClears.add(conversationId);
  }

  onSettlement(sessionKey: string): void {
    const conversationId = conversationIdOf(sessionKey);
    if (!this.pendingConversationClears.has(conversationId)) return;
    if (this.hasActiveRun(conversationId)) return;

    this.pendingConversationClears.delete(conversationId);
    this.discardConversation(conversationId);
  }

  private hasActiveRun(conversationId: string): boolean {
    for (const [sessionKey, state] of this.states) {
      if (
        conversationIdOf(sessionKey) === conversationId &&
        (state.running || state.runSettlement !== undefined)
      ) {
        return true;
      }
    }
    return false;
  }

  private discardConversation(conversationId: string): void {
    for (const sessionKey of Array.from(this.states.keys())) {
      if (conversationIdOf(sessionKey) === conversationId) this.discard(sessionKey);
    }
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
      if (
        !state.running &&
        state.runSettlement === undefined &&
        now - state.lastAccessedAt > this.idleTimeoutMs
      ) {
        this.discard(key);
      }
    }
    if (this.states.size <= this.maxSessions) return;

    const idle = Array.from(this.states.entries())
      .filter(([, state]) => !state.running && state.runSettlement === undefined)
      .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
    const toEvict = this.states.size - this.maxSessions;
    for (const [key] of idle.slice(0, toEvict)) this.discard(key);
  }
}
