import { describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler, OfficeAddress, RunningSession } from "../adapter.js";
import {
  formatToolArgs,
  MessagingEventQueue,
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
  splitText,
  withRetry,
} from "../adapters/shared.js";
import { createOfficeAddress, officeKey, sameOffice } from "../office/index.js";

const slack = createOfficeAddress("slack", "C123");

function makeHandler(running: Array<{ address: OfficeAddress; sessionKey: string }>) {
  const runningIds = new Set(running.map((s) => `${officeKey(s.address)}|${s.sessionKey}`));
  const runningSessions: RunningSession[] = running.map((session, index) => ({
    address: session.address,
    sessionKey: session.sessionKey,
    startedAt: index + 1,
  }));

  return {
    isRunning: vi.fn((address: OfficeAddress, key: string) =>
      runningIds.has(`${officeKey(address)}|${key}`),
    ),
    getRunningSessions: vi.fn().mockReturnValue(runningSessions),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
    handleExtensionAction: vi.fn(),
  } satisfies MessagingEventHandler;
}

function inSlack(...sessionKeys: string[]) {
  return sessionKeys.map((sessionKey) => ({ address: slack, sessionKey }));
}

describe("shared stop-target helpers", () => {
  test("resolveStopTarget only checks explicit session key and conversation key", () => {
    const handler = makeHandler(inSlack("C123:1000.0001"));

    expect(resolveStopTarget({ handler, address: slack, sessionKey: "C123:9999.0001" })).toBeNull();
  });

  test("resolveOnlyScopedStopTarget returns the only scoped running session", () => {
    const handler = makeHandler(inSlack("C123:1000.0001"));

    expect(resolveOnlyScopedStopTarget(handler, slack)).toBe("C123:1000.0001");
  });

  test("resolveOnlyScopedStopTarget returns null when scoped session is ambiguous", () => {
    const handler = makeHandler(inSlack("C123:1000.0001", "C123:1000.0002"));

    expect(resolveOnlyScopedStopTarget(handler, slack)).toBeNull();
  });

  describe("offices on different platforms never stop each other", () => {
    // Discord snowflakes and Telegram chat ids are both bare digits, so an id
    // alone cannot identify an office.
    const discord = createOfficeAddress("discord", "900100");
    const telegram = createOfficeAddress("telegram", "900100");

    test("a running session in one office is not a stop target in the other", () => {
      const handler = makeHandler([{ address: discord, sessionKey: "900100" }]);

      expect(resolveStopTarget({ handler, address: discord })).toBe("900100");
      expect(resolveStopTarget({ handler, address: telegram })).toBeNull();
    });

    test("widening to the only scoped session stays inside its office", () => {
      const handler = makeHandler([
        { address: discord, sessionKey: "900100:11" },
        { address: telegram, sessionKey: "900100:22" },
      ]);

      expect(resolveOnlyScopedStopTarget(handler, discord)).toBe("900100:11");
      expect(resolveOnlyScopedStopTarget(handler, telegram)).toBe("900100:22");
      expect(sameOffice(discord, telegram)).toBe(false);
    });
  });
});

describe("withRetry", () => {
  test("retries rate-limited errors and returns the eventual success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("429 slow down");
        return "ok";
      },
      { isRateLimited: () => true, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("non-rate-limited errors propagate immediately without retrying", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("channel_not_found");
        },
        { isRateLimited: () => false, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("channel_not_found");
    expect(calls).toBe(1);
  });

  test("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`attempt ${calls}`);
        },
        { isRateLimited: () => true, maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("attempt 2");
    expect(calls).toBe(2);
  });

  test("a non-Error throw still surfaces as an Error", async () => {
    await expect(
      withRetry(
        async () => {
          throw "string failure";
        },
        { isRateLimited: () => false },
      ),
    ).rejects.toThrow("string failure");
  });
});

describe("MessagingEventQueue", () => {
  test("a failing job is swallowed and later jobs still run", async () => {
    const queue = new MessagingEventQueue("test");
    const ran: string[] = [];
    queue.enqueue(async () => {
      throw new Error("boom");
    });
    queue.enqueue(async () => {
      ran.push("second");
    });

    await vi.waitFor(() => expect(ran).toEqual(["second"]));
  });

  test("jobs run one at a time, in enqueue order", async () => {
    const queue = new MessagingEventQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    queue.enqueue(async () => {
      events.push("first start");
      await gate;
      events.push("first end");
    });
    queue.enqueue(async () => {
      events.push("second");
    });

    // The second job must not start while the first is still awaiting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first start"]);

    release();
    await vi.waitFor(() => expect(events).toEqual(["first start", "first end", "second"]));
  });
});

const marker = (partNum: number) => `_(continued ${partNum})_`;

describe("splitText", () => {
  test("text within the limit is returned as a single untouched part", () => {
    expect(splitText("short", 100, marker)).toEqual(["short"]);
  });

  test("every part fits the limit and content survives minus the markers", () => {
    const text = "line\n".repeat(500);
    const parts = splitText(text, 400, marker);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(400);
    }
    const reassembled = parts.map((part) => part.replace(/\n_\(continued \d+\)_$/, "")).join("");
    expect(reassembled).toBe(text);
  });

  test("all parts except the last carry a continuation marker", () => {
    const parts = splitText("x".repeat(100), 40, marker);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) {
      expect(part).toMatch(/_\(continued \d+\)_$/);
    }
    expect(parts.at(-1)).not.toContain("continued");
  });
});

describe("formatToolArgs", () => {
  test("folds path with offset/limit into path:start-end and drops label", () => {
    expect(
      formatToolArgs({ label: "Read config", path: "src/config.ts", offset: 10, limit: 20 }),
    ).toBe("src/config.ts:10-30");
  });

  test("path without a range stays bare; other values are stringified", () => {
    expect(formatToolArgs({ path: "a.ts", cmd: "ls", count: 3, flags: { deep: true } })).toBe(
      'a.ts\nls\n3\n{"deep":true}',
    );
  });

  test("missing args render as empty", () => {
    expect(formatToolArgs(undefined)).toBe("");
  });
});
