import type { OfficeAddress } from "../adapter.js";
import * as log from "../log.js";
import { officeKey } from "../office/index.js";
import type { ConversationRuntimeState, SessionLifecycleOptions } from "./types.js";

const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_IDLE_TIMEOUT_MS = 3_600_000;
const MATERIALIZATION_ABORT_GRACE_MS = 5_000;

interface ConversationBarrier {
  activeWork: number;
  pendingMaintenance: number;
  maintenanceTail: Promise<void>;
  activeWaiters: Array<() => void>;
  workWaiters: Array<() => void>;
}

/** Runtime state is addressed by office plus the platform session key. */
function runtimeSessionId(address: OfficeAddress, sessionKey: string): string {
  return `${officeKey(address)}|${sessionKey}`;
}

export class SessionLifecycle {
  private readonly states = new Map<string, ConversationRuntimeState>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly transitions = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly leases = new Map<string, number>();
  private readonly settlementSessions = new Map<Promise<void>, string>();
  private readonly conversationBarriers = new Map<string, ConversationBarrier>();
  private readonly pendingConversationClears = new Set<string>();
  private readonly conversationGenerations = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private globalGeneration = 0;
  private shuttingDown = false;
  private readonly materializationAbort = new AbortController();

  constructor(options: SessionLifecycleOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get(address: OfficeAddress, sessionKey: string): ConversationRuntimeState | undefined {
    return this.states.get(runtimeSessionId(address, sessionKey));
  }

  /** Test/support insertion. Production materialization goes through acquire(). */
  set(state: ConversationRuntimeState): void {
    this.states.set(runtimeSessionId(state.address, state.sessionKey), state);
  }

  async acquire(
    address: OfficeAddress,
    sessionKey: string,
    expectedFile: () => string | null | undefined,
    materialize: (signal: AbortSignal) => Promise<ConversationRuntimeState>,
  ): Promise<{ state: ConversationRuntimeState; release: () => void }> {
    if (this.shuttingDown) throw new Error("Session lifecycle is shutting down");
    return this.transition(address, sessionKey, async () => {
      const state = await this.materializeExclusive(address, sessionKey, expectedFile, materialize);
      const id = runtimeSessionId(address, sessionKey);
      this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
      return { state, release: this.createLeaseRelease(id, address) };
    });
  }

  private async materializeExclusive(
    address: OfficeAddress,
    sessionKey: string,
    expectedFile: () => string | null | undefined,
    materialize: (signal: AbortSignal) => Promise<ConversationRuntimeState>,
  ): Promise<ConversationRuntimeState> {
    const id = runtimeSessionId(address, sessionKey);
    while (true) {
      if (this.shuttingDown) throw new Error("Session lifecycle is shutting down");
      await this.waitForClose(address, sessionKey);
      const existing = this.states.get(id);
      if (existing && expectedFile() === existing.sessionFile) {
        existing.lastAccessedAt = this.now();
        return existing;
      }
      if (existing && this.isStateActive(id, existing)) return existing;
      if (existing) await this.discardAndWait(address, sessionKey);

      const generation = this.generation(address);
      const state = await materialize(this.materializationAbort.signal);
      if (!this.shuttingDown && generation === this.generation(address)) {
        this.states.set(id, state);
        return state;
      }
      await state.runner.dispose();
      if (this.shuttingDown) throw new Error("Session lifecycle is shutting down");
    }
  }

  private createLeaseRelease(id: string, address: OfficeAddress): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseLease(id, address);
    };
  }

  private releaseLease(id: string, address: OfficeAddress): void {
    const count = this.leases.get(id) ?? 0;
    if (count <= 1) this.leases.delete(id);
    else this.leases.set(id, count - 1);
    this.applyDeferredClear(address);
  }

  settle(
    state: ConversationRuntimeState,
    work: () => Promise<void>,
    options: { markRunning?: boolean } = {},
  ): Promise<void> {
    const id = runtimeSessionId(state.address, state.sessionKey);
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    if (options.markRunning !== false) {
      state.running = true;
      state.stopRequested = false;
      state.startedAt = this.now();
      state.lastActivityAt = this.now();
    }

    let settlement!: Promise<void>;
    settlement = Promise.resolve()
      .then(work)
      .finally(() => this.finishSettlement(state, settlement, id));
    state.runSettlement = settlement;
    this.settlementSessions.set(settlement, id);
    return settlement;
  }

  private finishSettlement(
    state: ConversationRuntimeState,
    settlement: Promise<void>,
    id: string,
  ): void {
    this.settlementSessions.delete(settlement);
    if (state.runSettlement === settlement) state.runSettlement = undefined;
    state.running = false;
    state.startedAt = 0;
    state.lastAccessedAt = this.now();
    this.releaseLease(id, state.address);
    this.evictIdle();
  }

  settlementCount(): number {
    return this.settlementSessions.size;
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

  runningStates(): ConversationRuntimeState[] {
    return Array.from(this.states.values()).filter((state) => state.running);
  }

  offices(): OfficeAddress[] {
    const offices = new Map<string, OfficeAddress>();
    for (const state of this.states.values()) offices.set(officeKey(state.address), state.address);
    return Array.from(offices.values());
  }

  officesForConversationId(conversationId: string): OfficeAddress[] {
    return this.offices().filter((address) => address.conversationId === conversationId);
  }

  invalidateConversation(address: OfficeAddress): boolean {
    const key = officeKey(address);
    this.conversationGenerations.set(key, (this.conversationGenerations.get(key) ?? 0) + 1);
    return this.clearConversation(address);
  }

  invalidateAll(): { busy: OfficeAddress[] } {
    this.globalGeneration++;
    const busy: OfficeAddress[] = [];
    for (const address of this.offices()) {
      if (this.clearConversation(address)) continue;
      this.deferConversationClear(address);
      busy.push(address);
    }
    return { busy };
  }

  clearConversation(address: OfficeAddress): boolean {
    if (this.hasActiveWork(address)) return false;
    this.pendingConversationClears.delete(officeKey(address));
    this.discardConversation(address);
    return true;
  }

  deferConversationClear(address: OfficeAddress): void {
    this.pendingConversationClears.add(officeKey(address));
  }

  private applyDeferredClear(address: OfficeAddress): void {
    const key = officeKey(address);
    if (!this.pendingConversationClears.has(key) || this.hasActiveWork(address)) return;
    this.pendingConversationClears.delete(key);
    this.discardConversation(address);
  }

  private hasActiveWork(address: OfficeAddress): boolean {
    const key = officeKey(address);
    for (const state of this.states.values()) {
      const id = runtimeSessionId(state.address, state.sessionKey);
      if (officeKey(state.address) === key && this.isStateActive(id, state)) return true;
    }
    return false;
  }

  private isStateActive(id: string, state: ConversationRuntimeState): boolean {
    return (this.leases.get(id) ?? 0) > 0 || state.running || state.runSettlement !== undefined;
  }

  private discardConversation(address: OfficeAddress): void {
    const key = officeKey(address);
    for (const state of Array.from(this.states.values())) {
      if (officeKey(state.address) === key) this.discard(state.address, state.sessionKey);
    }
  }

  private generation(address: OfficeAddress): string {
    return `${this.globalGeneration}:${this.conversationGenerations.get(officeKey(address)) ?? 0}`;
  }

  async transition<T>(
    address: OfficeAddress,
    sessionKey: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const id = runtimeSessionId(address, sessionKey);
    const previous = this.transitions.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.transitions.set(id, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.transitions.get(id) === tail) this.transitions.delete(id);
    }
  }

  /** Explicit reset/replacement path; caller guarantees the runner will not be used again. */
  async discardAndWait(address: OfficeAddress, sessionKey: string): Promise<void> {
    const id = runtimeSessionId(address, sessionKey);
    const state = this.states.get(id);
    if (!state) {
      await this.closing.get(id);
      return;
    }
    this.states.delete(id);
    const close = state.runner.dispose();
    this.trackClosing(id, close);
    await close;
  }

  async waitForClose(address: OfficeAddress, sessionKey: string): Promise<void> {
    await this.closing.get(runtimeSessionId(address, sessionKey));
  }

  async closeAll(): Promise<void> {
    const states = Array.from(this.states.values());
    this.states.clear();
    for (const state of states) {
      const id = runtimeSessionId(state.address, state.sessionKey);
      this.trackClosing(id, state.runner.dispose());
    }
    await Promise.all(this.closing.values());
  }

  private discard(address: OfficeAddress, sessionKey: string): void {
    const id = runtimeSessionId(address, sessionKey);
    const state = this.states.get(id);
    if (!state) return;
    this.states.delete(id);
    const close = state.runner.dispose();
    this.trackClosing(id, close);
    close.catch((err: unknown) => {
      log.logWarning(
        `Runner dispose failed: ${sessionKey}`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private trackClosing(id: string, close: Promise<void>): void {
    this.closing.set(id, close);
    const clear = () => {
      if (this.closing.get(id) === close) this.closing.delete(id);
    };
    void close.then(clear, clear);
  }

  evictIdle(): void {
    const now = this.now();
    for (const state of Array.from(this.states.values())) {
      const id = runtimeSessionId(state.address, state.sessionKey);
      if (!this.isStateActive(id, state) && now - state.lastAccessedAt > this.idleTimeoutMs) {
        this.discard(state.address, state.sessionKey);
      }
    }
    if (this.states.size <= this.maxSessions) return;

    const idle = Array.from(this.states.values())
      .filter(
        (state) => !this.isStateActive(runtimeSessionId(state.address, state.sessionKey), state),
      )
      .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    const toEvict = this.states.size - this.maxSessions;
    for (const state of idle.slice(0, toEvict)) this.discard(state.address, state.sessionKey);
  }

  async shutdown(timeoutMs: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const materializationDeadline = Date.now() + MATERIALIZATION_ABORT_GRACE_MS;
    this.materializationAbort.abort(new Error("Session lifecycle is shutting down"));
    const timeout = Date.now() + timeoutMs;
    await this.waitForActiveWork(timeout, 500);

    if (this.activeWorkCount() > 0) {
      log.logWarning(
        `Aborting ${this.activeWorkCount()} runs after shutdown timeout`,
        `${timeoutMs}ms`,
      );
      for (const state of this.runningStates()) state.runner.abort();
      await this.waitForActiveWork(Date.now() + 5_000, 100);
      if (this.activeWorkCount() > 0) {
        throw new Error(
          `Shutdown could not settle ${this.activeWorkCount()} aborted runs within 5000ms`,
        );
      }
    }

    await this.waitForMaterializations(materializationDeadline);
    await this.closeAll();
  }

  private async waitForMaterializations(deadline: number): Promise<void> {
    if (this.transitions.size === 0) return;
    let timeout: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.all(this.transitions.values()).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!settled) {
      throw new Error(
        `Shutdown could not settle ${this.transitions.size} runner materializations within ${MATERIALIZATION_ABORT_GRACE_MS}ms`,
      );
    }
  }

  private async waitForActiveWork(deadline: number, intervalMs: number): Promise<void> {
    while (this.activeWorkCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private activeWorkCount(): number {
    const sessionIds = new Set(this.leases.keys());
    for (const sessionId of this.settlementSessions.values()) {
      sessionIds.add(sessionId);
    }
    return sessionIds.size;
  }
}
