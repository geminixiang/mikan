import { describe, expect, test, vi } from "vitest";
import { BufferedResponseStream } from "../src/adapters/streaming.js";

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
