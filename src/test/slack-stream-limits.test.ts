import { describe, expect, test } from "vitest";
import { StreamStartLimiter } from "../adapters/slack/stream-limits.js";
import { chunkStreamText } from "../adapters/slack/bot.js";

/**
 * `chat.startStream` sits in a much tighter tier than `chat.postMessage`, and
 * every streamed reply spends one start plus one stop — so the ceiling is
 * streams opened per minute, which a burst of mentions or a batch of
 * scheduled runs reaches easily. Refusing before spending the request turns a
 * 429 and a visibly worse first response into a silent downgrade to the
 * edit-based path.
 */
describe("StreamStartLimiter", () => {
  test("allows up to the limit and then refuses", () => {
    const limiter = new StreamStartLimiter(3, 60_000, () => 1000);
    expect([limiter.tryReserve(), limiter.tryReserve(), limiter.tryReserve()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryReserve()).toBe(false);
    expect(limiter.used).toBe(3);
  });

  test("the window rolls rather than resetting on a boundary", () => {
    let now = 0;
    const limiter = new StreamStartLimiter(2, 1000, () => now);

    now = 100;
    expect(limiter.tryReserve()).toBe(true);
    now = 900;
    expect(limiter.tryReserve()).toBe(true);
    now = 950;
    expect(limiter.tryReserve()).toBe(false);

    // The first reservation ages out; the second has not.
    now = 1150;
    expect(limiter.tryReserve()).toBe(true);
    expect(limiter.tryReserve()).toBe(false);

    // A fixed bucket would have let four through across the boundary — the
    // exact burst shape this exists to survive.
    now = 2200;
    expect(limiter.used).toBe(0);
  });

  test("refusal is not sticky once the window clears", () => {
    let now = 0;
    const limiter = new StreamStartLimiter(1, 1000, () => now);
    expect(limiter.tryReserve()).toBe(true);
    expect(limiter.tryReserve()).toBe(false);
    now = 1001;
    expect(limiter.tryReserve()).toBe(true);
  });
});

describe("chunkStreamText", () => {
  test("leaves text within the limit untouched", () => {
    expect(chunkStreamText("short", 10)).toEqual(["short"]);
    expect(chunkStreamText("exactlyten", 10)).toEqual(["exactlyten"]);
  });

  test("splits oversized text into pieces that each fit one call", () => {
    const chunks = chunkStreamText("abcdefghijklmno", 10);
    expect(chunks).toEqual(["abcdefghij", "klmno"]);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  });

  test("reassembles to exactly the original", () => {
    // Splitting mid-word or mid-fence is harmless because a stream
    // concatenates — but only if nothing is dropped or duplicated.
    const text = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`).join("");
    const chunks = chunkStreamText(text, 12_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("handles an empty string without emitting nothing", () => {
    expect(chunkStreamText("", 10)).toEqual([""]);
  });
});
