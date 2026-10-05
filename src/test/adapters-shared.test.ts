import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler, OfficeAddress, RunningSession } from "../types.js";
import {
  MAX_PENDING_EVENTS,
  saveIncomingAttachments,
  writeResponseToFile,
  MessagingEventQueue,
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
  shortNameToUnicodeEmoji,
  splitText,
  withRetry,
} from "../adapters/shared.js";
import { appendOfficeLog } from "../office/log.js";
import { formatToolArgs } from "../harness/tool-args.js";
import {
  createConversationEvent,
  createOfficeAddress,
  createWorkspace,
  officeKey,
  sameOffice,
} from "../office/index.js";
import type { Office } from "../office/types.js";

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
  test("admit reports whether work waits behind earlier work", async () => {
    const queue = new MessagingEventQueue("test");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    expect(queue.admit(() => gate)).toBe("started");
    expect(queue.admit(async () => {})).toBe("waiting");
    release();
    const closed = queue.close();
    expect(queue.admit(async () => {})).toBe("closed");
    await closed;
    expect(queue.admit(async () => {})).toBe("closed");
  });

  test("admit starts work at once on an idle queue", async () => {
    const queue = new MessagingEventQueue("test");
    await new Promise<void>((resolve) => queue.admit(async () => resolve()));
    expect(queue.admit(async () => {})).toBe("started");
  });

  test("offerEvent rejects an event once the pending events reach the limit", async () => {
    const queue = new MessagingEventQueue("test");
    const event = createConversationEvent({
      platform: "slack",
      type: "mention",
      conversationId: "C1",
      conversationKind: "shared",
      user: "EVENT",
      text: "scheduled",
      ts: "event:1",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: number[] = [];

    const accepted = Array.from({ length: MAX_PENDING_EVENTS + 2 }, (_, index) =>
      queue.offerEvent(event, async () => {
        ran.push(index);
        await gate;
      }),
    );

    expect(accepted).toEqual([...Array(MAX_PENDING_EVENTS + 1).fill(true), false]);
    release();
    await vi.waitFor(() => expect(ran).toHaveLength(MAX_PENDING_EVENTS + 1));
  });

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

describe("shortNameToUnicodeEmoji", () => {
  test("translates the short names the prompt recommends", () => {
    expect(shortNameToUnicodeEmoji("saluting_face")).toBe("\u{1FAE1}");
    expect(shortNameToUnicodeEmoji("eyes")).toBe("\u{1F440}");
  });

  test("strips wrapping colons before lookup", () => {
    expect(shortNameToUnicodeEmoji(":eyes:")).toBe("\u{1F440}");
  });

  test("passes through an unmapped name unchanged", () => {
    expect(shortNameToUnicodeEmoji("not_a_real_emoji")).toBe("not_a_real_emoji");
  });

  test("passes through an already-Unicode emoji unchanged", () => {
    expect(shortNameToUnicodeEmoji("\u{1F440}")).toBe("\u{1F440}");
  });
});

describe("office files the agent can replace", () => {
  let root: string;
  let office: Office;
  let hostFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mikan-office-files-"));
    const workspace = createWorkspace({
      root: join(root, "workspace"),
      stateDir: join(root, "state"),
    });
    office = workspace.office(slack);
    office.ensure();
    hostFile = join(root, "host-only.txt");
    writeFileSync(hostFile, "host\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("appending to the conversation log never writes through a link", () => {
    symlinkSync(hostFile, office.logPath);
    expect(() => appendOfficeLog(office, { text: "hi" })).toThrow(/symbolic link/);
    expect(readFileSync(hostFile, "utf-8")).toBe("host\n");
  });

  test("attachments are never written through a linked attachments directory", async () => {
    const hostDir = join(root, "host-dir");
    mkdirSync(hostDir);
    symlinkSync(hostDir, office.attachmentsDir);
    const result = await saveIncomingAttachments(office, [
      {
        name: "a.txt",
        timestampMs: 1,
        download: (destPath) => writeResponseToFile(new Response("data"), destPath),
      },
    ]);
    expect(readdirSync(hostDir)).toEqual([]);
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  test("an attachment already present as a link is not written through", async () => {
    mkdirSync(office.attachmentsDir);
    symlinkSync(hostFile, join(office.attachmentsDir, "1_a.txt"));
    const result = await saveIncomingAttachments(office, [
      {
        name: "a.txt",
        timestampMs: 1,
        download: (destPath) => writeResponseToFile(new Response("data"), destPath),
      },
    ]);
    expect(readFileSync(hostFile, "utf-8")).toBe("host\n");
    expect(result.failed).toHaveLength(1);
  });

  test.runIf(process.platform === "linux")(
    "an attachments directory swapped for a link during download still receives the file",
    async () => {
      const hostDir = join(root, "host-dir");
      mkdirSync(hostDir);
      const result = await saveIncomingAttachments(office, [
        {
          name: "a.txt",
          timestampMs: 1,
          download: async (destPath) => {
            renameSync(office.attachmentsDir, join(office.dir, "moved"));
            symlinkSync(hostDir, office.attachmentsDir);
            await writeResponseToFile(new Response("data"), destPath);
          },
        },
      ]);
      expect(readdirSync(hostDir)).toEqual([]);
      expect(readdirSync(join(office.dir, "moved"))).toEqual(["1_a.txt"]);
      expect(result.saved).toHaveLength(1);
    },
  );
});
