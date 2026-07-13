import { describe, expect, test, vi } from "vitest";
import { BufferedResponseStream, OrderedResponseOperations } from "../src/adapters/streaming.js";

describe("OrderedResponseOperations", () => {
  test("runs operations in order", async () => {
    const operations = new OrderedResponseOperations();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = operations.run(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = operations.run(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("recovers after a failed operation", async () => {
    const operations = new OrderedResponseOperations();
    const failure = new Error("failed");
    const failed = operations.run(() => Promise.reject(failure));
    const next = vi.fn().mockResolvedValue(undefined);
    const recovered = operations.run(next);

    await expect(failed).rejects.toBe(failure);
    await recovered;
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("BufferedResponseStream", () => {
  test("flushes immediately on first delta and buffers small subsequent deltas", async () => {
    let now = 1000;
    const flush = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    const stream = new BufferedResponseStream(
      { flush, finish },
      { now: () => now, minFlushIntervalMs: 750, minFlushChars: 80 },
    );

    await stream.append("hello");
    await stream.append(" world");

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("hello");
    expect(stream.getText()).toBe("hello world");
  });

  test("flushes buffered deltas after interval", async () => {
    let now = 1000;
    const flush = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    const stream = new BufferedResponseStream(
      { flush, finish },
      { now: () => now, minFlushIntervalMs: 750, minFlushChars: 80 },
    );

    await stream.append("hello");
    now += 800;
    await stream.append(" world");

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith("hello world");
  });

  test("finish always emits final text", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    const stream = new BufferedResponseStream({ flush, finish });

    await stream.append("draft");
    await stream.finish("final");

    expect(finish).toHaveBeenCalledWith("final");
    expect(stream.getText()).toBe("final");
  });
});
