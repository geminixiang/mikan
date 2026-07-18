/**
 * Process-wide subagent fan-out account. The per-conversation queues
 * serialize agent runs, and each run's subagent tool bounds its own fan-out
 * — but without a shared ceiling, N busy conversations hold N × per-run-cap
 * live subagent sessions. Every subagent launch draws a slot from one shared
 * pool; the per-run cap and this global ceiling are the two bounds, enforced
 * where each concrete subagent session is launched.
 */

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

/** Default process-wide ceiling on concurrently live subagent sessions. */
export const DEFAULT_GLOBAL_SUBAGENT_SLOTS = 8;

/** Async slot pool: at most `capacity` concurrent holders, FIFO waiters. */
export class SubagentSlotPool {
  private held = 0;
  private waiters: Array<{
    resolve: (release: () => void) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) {
      throw new Error(`SubagentSlotPool capacity must be >= 1, got ${capacity}`);
    }
  }

  /** Currently held slots (for tests and capacity reporting). */
  get inFlight(): number {
    return this.held;
  }

  /**
   * Resolve with a release function once a slot frees up. Call the release
   * exactly once; releasing hands the slot to the oldest waiter.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.held < this.capacity) {
      this.held += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort!);
        next.resolve(this.releaser());
        return;
      }
      this.held -= 1;
    };
  }
}

/** A pool that never blocks — the default when no shared ceiling is wired. */
export function unboundedSlotPool(): SubagentSlotPool {
  return new SubagentSlotPool(Number.MAX_SAFE_INTEGER);
}
