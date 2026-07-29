import type { OfficeAddress } from "../adapter.js";
import * as log from "../log.js";
import { officeKey } from "../office/index.js";
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

/**
 * Runtime state is addressed by office, not by session key alone.
 *
 * A session key is a platform value: a Discord channel and a Telegram chat can
 * legitimately produce the same string, and every platform shares this one
 * lifecycle. The internal map key therefore prefixes the office key, which
 * carries the platform plus a digest of the raw conversation id. Callers only
 * ever pass `(address, sessionKey)`; the composite never leaves this module,
 * so nothing downstream can parse it or invent one.
 */
function runtimeSessionId(address: OfficeAddress, sessionKey: string): string {
  return `${officeKey(address)}|${sessionKey}`;
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

  get(address: OfficeAddress, sessionKey: string): ConversationRuntimeState | undefined {
    return this.states.get(runtimeSessionId(address, sessionKey));
  }

  /** The state carries its own identity, so it cannot be filed under another. */
  set(state: ConversationRuntimeState): void {
    this.states.set(runtimeSessionId(state.address, state.sessionKey), state);
  }

  async enqueue(
    address: OfficeAddress,
    sessionKey: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const id = runtimeSessionId(address, sessionKey);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.queues.set(id, next);
    try {
      await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }

  async acquireConversationWork(address: OfficeAddress): Promise<() => void> {
    const barrier = this.getConversationBarrier(address);
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
    address: OfficeAddress,
    maintenance: () => Promise<T>,
  ): Promise<T> {
    const barrier = this.getConversationBarrier(address);
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

  private getConversationBarrier(address: OfficeAddress): ConversationBarrier {
    const key = officeKey(address);
    const existing = this.conversationBarriers.get(key);
    if (existing) return existing;

    const barrier: ConversationBarrier = {
      activeWork: 0,
      pendingMaintenance: 0,
      maintenanceTail: Promise.resolve(),
      activeWaiters: [],
      workWaiters: [],
    };
    this.conversationBarriers.set(key, barrier);
    return barrier;
  }

  isRunning(address: OfficeAddress, sessionKey: string): boolean {
    return this.get(address, sessionKey)?.running === true;
  }

  runningStates(): ConversationRuntimeState[] {
    return Array.from(this.states.values()).filter((state) => state.running);
  }

  /** Every office holding runtime state, deduplicated by office key. */
  offices(): OfficeAddress[] {
    const offices = new Map<string, OfficeAddress>();
    for (const state of this.states.values()) offices.set(officeKey(state.address), state.address);
    return Array.from(offices.values());
  }

  /**
   * Resolve the offices behind a raw conversation id. Settings, the filesystem,
   * and Admin scope still address offices by raw id (ADR 0005), so this is the
   * bridge until they carry an `OfficeAddress`. Two platforms sharing a raw id
   * yield both offices, matching the raw-id scope those callers expect today.
   */
  officesForConversationId(conversationId: string): OfficeAddress[] {
    return this.offices().filter((address) => address.conversationId === conversationId);
  }

  clearConversation(address: OfficeAddress): boolean {
    if (this.hasActiveRun(address)) return false;
    this.pendingConversationClears.delete(officeKey(address));
    this.discardConversation(address);
    return true;
  }

  deferConversationClear(address: OfficeAddress): void {
    this.pendingConversationClears.add(officeKey(address));
  }

  onSettlement(address: OfficeAddress): void {
    const key = officeKey(address);
    if (!this.pendingConversationClears.has(key)) return;
    if (this.hasActiveRun(address)) return;

    this.pendingConversationClears.delete(key);
    this.discardConversation(address);
  }

  private hasActiveRun(address: OfficeAddress): boolean {
    const key = officeKey(address);
    for (const state of this.states.values()) {
      if (
        officeKey(state.address) === key &&
        (state.running || state.runSettlement !== undefined)
      ) {
        return true;
      }
    }
    return false;
  }

  private discardConversation(address: OfficeAddress): void {
    const key = officeKey(address);
    for (const state of Array.from(this.states.values())) {
      if (officeKey(state.address) === key) this.discard(state.address, state.sessionKey);
    }
  }

  discard(address: OfficeAddress, sessionKey: string): void {
    const id = runtimeSessionId(address, sessionKey);
    const state = this.states.get(id);
    if (!state) return;
    this.states.delete(id);
    state.runner.dispose().catch((err: unknown) => {
      log.logWarning(
        `Runner dispose failed: ${sessionKey}`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  evictIdle(): void {
    const now = this.now();
    for (const state of Array.from(this.states.values())) {
      if (
        !state.running &&
        state.runSettlement === undefined &&
        now - state.lastAccessedAt > this.idleTimeoutMs
      ) {
        this.discard(state.address, state.sessionKey);
      }
    }
    if (this.states.size <= this.maxSessions) return;

    const idle = Array.from(this.states.values())
      .filter((state) => !state.running && state.runSettlement === undefined)
      .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    const toEvict = this.states.size - this.maxSessions;
    for (const state of idle.slice(0, toEvict)) this.discard(state.address, state.sessionKey);
  }
}
