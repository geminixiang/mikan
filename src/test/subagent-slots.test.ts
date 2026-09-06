import { describe, expect, test } from "vitest";
import { SubagentSlotPool, unboundedSlotPool } from "../harness/subagent-slots.js";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("Expected the promise to reject");
    },
    (err: Error) => err,
  );
}

describe("SubagentSlotPool", () => {
  test("rejects a capacity below one", () => {
    expect(() => new SubagentSlotPool(0)).toThrow("capacity must be >= 1");
  });

  test("hands freed slots to waiters in FIFO order", async () => {
    const pool = new SubagentSlotPool(1);
    const order: number[] = [];
    const release = await pool.acquire();
    const first = pool.acquire().then((releaseFirst) => {
      order.push(1);
      return releaseFirst;
    });
    const second = pool.acquire().then((releaseSecond) => {
      order.push(2);
      return releaseSecond;
    });

    release();
    (await first)();
    (await second)();

    expect(order).toEqual([1, 2]);
    expect(pool.inFlight).toBe(0);
  });

  test("an aborted waiter leaves the queue and does not take the freed slot", async () => {
    const pool = new SubagentSlotPool(1);
    const controller = new AbortController();
    const release = await pool.acquire();
    const aborted = pool.acquire(controller.signal);
    const next = pool.acquire();

    controller.abort();
    const err = await rejection(aborted);
    expect(err.name).toBe("AbortError");

    release();
    const releaseNext = await next;
    expect(pool.inFlight).toBe(1);
    releaseNext();
    expect(pool.inFlight).toBe(0);
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const pool = new SubagentSlotPool(1);
    const controller = new AbortController();
    controller.abort();

    const err = await rejection(pool.acquire(controller.signal));
    expect(err.name).toBe("AbortError");
    expect(pool.inFlight).toBe(0);
  });

  test("releasing twice hands out at most one slot", async () => {
    const pool = new SubagentSlotPool(1);
    const release = await pool.acquire();

    release();
    release();

    expect(pool.inFlight).toBe(0);
    const next = await pool.acquire();
    expect(pool.inFlight).toBe(1);
    next();
    expect(pool.inFlight).toBe(0);
  });

  test("an unbounded pool never blocks", async () => {
    const pool = unboundedSlotPool();
    const releases = [await pool.acquire(), await pool.acquire(), await pool.acquire()];
    expect(pool.inFlight).toBe(3);
    for (const release of releases.toReversed()) release();
    expect(pool.inFlight).toBe(0);
  });
});
