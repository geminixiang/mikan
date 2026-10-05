import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionStore } from "../sessions/session-store.js";
import { RUN_CAUSE_CUSTOM_TYPE } from "../sessions/types.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatHistorySync, registerThreadSession } from "../sessions/chat-history-sync.js";
import { isCommandText } from "../adapters/commands/manifest.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import type { ThreadRootMessage } from "../sessions/types.js";

let root: string;
let office: Office;
let conversationDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chat-session-manager-test-"));
  office = createWorkspace({ root: join(root, "workspace"), stateDir: join(root, "state") }).office(
    createOfficeAddress("slack", "C123"),
  );
  conversationDir = office.dir;
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLog(entries: object[]): void {
  writeFileSync(
    join(conversationDir, "log.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf-8",
  );
}

async function inspectSession(sessionKey: string) {
  const session = await SessionStore.inspect(office, sessionKey);
  if (!session) throw new Error(`No session for ${sessionKey}`);
  return session;
}

async function resolveScope(
  manager: ChatHistorySync,
  options: Parameters<ChatHistorySync["resolveSessionScope"]>[0],
): Promise<{ key: string; threadRootMessage: ThreadRootMessage | null }> {
  const scope = await manager.resolveSessionScope(options);
  return { key: options.sessionKey, threadRootMessage: scope.threadRootMessage };
}

async function readContextText(sessionFile: string): Promise<string> {
  const session = await inspectSession(sessionFile);
  const context = await session.buildSessionContext();
  return context.messages
    .map((message) => {
      return typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    })
    .join("\n---\n");
}

async function sessionRaw(sessionFile: string): Promise<string> {
  const session = await inspectSession(sessionFile);
  return JSON.stringify(await session.getEntries());
}

async function countJsonlEntries(
  sessionFile: string,
  predicate: (entry: { type?: string; customType?: string }) => boolean,
): Promise<number> {
  const session = await inspectSession(sessionFile);
  const entries: Array<{ type?: string; customType?: string }> = [
    { type: "session" },
    ...(await session.getEntries()),
  ];
  return entries.filter(predicate).length;
}

async function syncViaRuntimePath(
  manager: ChatHistorySync,
  target: Office,
  sessionKey: string,
  contextFile: string,
  currentMessageId?: string,
): Promise<void> {
  const session = await SessionStore.open(target, contextFile);
  try {
    await manager.syncSessionManager({
      office: target,
      sessionKey,
      sessionManager: session,
      ...(currentMessageId !== undefined ? { currentMessageId } : {}),
    });
  } finally {
    await session.close();
  }
}

describe("ChatHistorySync", () => {
  test("/new resets only its own session and keeps the others' context", async () => {
    writeLog([]);
    for (const key of ["C123", "C123:1000.1", "C123:2000.1"]) {
      const session = await SessionStore.open(office, key);
      await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: `work in ${key}` }],
        timestamp: 1,
      });
      await session.close();
    }
    const manager = new ChatHistorySync({ isCommandText });

    await manager.resetSession({ office, sessionKey: "C123" });
    await manager.resetSession({ office, sessionKey: "C123:1000.1" });

    expect(await readContextText("C123")).not.toContain("work in C123");
    expect(await readContextText("C123:1000.1")).not.toContain("work in C123:1000.1");
    expect(await readContextText("C123:2000.1")).toContain("work in C123:2000.1");
    expect(await sessionRaw("C123")).toContain("work in C123");
  });

  test("reset accepts new IDs with the same text without replaying the old context", async () => {
    const before = {
      date: "2026-05-01T00:00:00.000Z",
      ts: "1000.0001",
      user: "U1",
      userName: "alice",
      text: "thanks",
      isMessagingBot: false,
    };
    writeLog([before]);
    let now = new Date("2026-05-01T00:00:01.000Z");
    const manager = new ChatHistorySync({ isCommandText, now: () => now });
    await manager.resolveSessionScope({ office, sessionKey: "C123" });
    now = new Date("2026-05-02T00:00:00.000Z");
    await manager.resetSession({ office, sessionKey: "C123" });
    writeLog([
      before,
      { ...before, date: "2026-05-02T00:00:01.000Z", ts: "2000.0001", userName: "bob", user: "U2" },
    ]);
    now = new Date("2026-05-02T00:00:02.000Z");
    await syncViaRuntimePath(manager, office, "C123", "C123");
    const text = await readContextText("C123");
    expect(text).toContain("[bob]: thanks");
    expect(text).not.toContain("[alice]: thanks");
    expect(text.match(/: thanks/g)).toHaveLength(1);

    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect(await readContextText("C123")).toBe(text);
  });

  test("reset excludes pre-reset messages that are logged late", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        text: "already logged old message",
        isMessagingBot: false,
      },
    ]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:10.000Z"),
    });
    await manager.resetSession({ office, sessionKey: "C123" });
    const freshFile = "C123";

    appendFileSync(
      join(conversationDir, "log.jsonl"),
      [
        JSON.stringify({
          date: "2026-05-01T00:00:05.000Z",
          ts: "1000.0002",
          user: "U1",
          text: "late pre-reset message",
          isMessagingBot: false,
        }),
        JSON.stringify({
          date: "2026-05-01T00:00:11.000Z",
          ts: "1000.0003",
          user: "U1",
          text: "new message",
          isMessagingBot: false,
        }),
      ].join("\n") + "\n",
    );

    await syncViaRuntimePath(manager, office, "C123", freshFile, "1000.0003");
    let text = await readContextText(freshFile);
    expect(text).not.toContain("already logged old message");
    expect(text).not.toContain("late pre-reset message");

    appendFileSync(
      join(conversationDir, "log.jsonl"),
      JSON.stringify({
        date: "2026-05-01T00:00:12.000Z",
        ts: "1000.0004",
        user: "U1",
        text: "following message",
        isMessagingBot: false,
      }) + "\n",
    );
    await syncViaRuntimePath(manager, office, "C123", freshFile, "1000.0004");
    text = await readContextText(freshFile);
    expect(text).toContain("new message");
    expect(text).not.toContain("late pre-reset message");
  });

  test("reset does not replay late records without a trustworthy event date", async () => {
    writeLog([]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:10.000Z"),
    });
    await manager.resetSession({ office, sessionKey: "C123" });
    const freshFile = "C123";

    appendFileSync(
      join(conversationDir, "log.jsonl"),
      [
        JSON.stringify({
          ts: "opaque-platform-id",
          user: "U1",
          text: "undated stale message",
          isMessagingBot: false,
        }),
        JSON.stringify({
          date: "not-a-date",
          ts: "999999999999999999",
          user: "U1",
          text: "malformed stale message",
          isMessagingBot: false,
        }),
        JSON.stringify({
          date: "2026-05-01T00:00:11.000Z",
          ts: "new-platform-id",
          user: "U1",
          text: "dated new message",
          isMessagingBot: false,
        }),
      ].join("\n") + "\n",
    );

    await manager.resolveSessionScope({
      office,
      sessionKey: "C123",
      currentMessageId: "new-platform-id",
    });
    const text = await readContextText(freshFile);
    expect(text).not.toContain("undated stale message");
    expect(text).not.toContain("malformed stale message");
  });

  test("bootstraps a top-level session from recent log history and excludes current message", async () => {
    writeLog([
      {
        date: "2026-04-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "too old",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "recent question",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0003",
        user: "bot",
        text: "recent answer",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "current message",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });

    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0004",
    });

    const text = await readContextText(scope.key);
    expect(text).toContain("recent question");
    expect(text).toContain("recent answer");
    expect(text).not.toContain("too old");
    expect(text).not.toContain("current message");
  });

  test("bootstraps only history before the current message when a later message is already queued", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "completed history",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "current message",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "queued future message",
        isMessagingBot: false,
      },
    ]);

    await new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    }).resolveSessionScope({
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0002",
    });

    const text = await readContextText("C123");
    expect(text).toContain("completed history");
    expect(text).not.toContain("current message");
    expect(text).not.toContain("queued future message");
  });

  test("incremental sync does not append a later queued message before its turn", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "first turn",
        isMessagingBot: false,
      },
    ]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0001",
    });

    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "first turn",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "bot",
        text: "first answer",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "current turn",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "queued future turn",
        isMessagingBot: false,
      },
    ]);

    const session = await SessionStore.open(office, scope.key);
    await manager.syncSessionManager({
      office,
      sessionKey: "C123",
      sessionManager: session,
      currentMessageId: "1000.0003",
    });
    await session.close();

    const text = await readContextText(scope.key);
    expect(text).toContain("first answer");
    expect(text).not.toContain("current turn");
    expect(text).not.toContain("queued future turn");
  });

  test("coalesces streamed bot log chunks before applying top-level history limit", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "question",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "bot",
        text: "One",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:01.001Z",
        ts: "1000.0002",
        user: "bot",
        text: " two",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:01.002Z",
        ts: "1000.0002",
        user: "bot",
        text: " three",
        isMessagingBot: true,
      },
    ]);

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 2,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });

    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
    });

    const text = await readContextText(scope.key);
    expect(text).toContain("question");
    expect(text).toContain("One two three");
    expect(await countJsonlEntries(scope.key, (entry) => entry.type === "message")).toBe(2);
  });

  async function channelWithRuns(): Promise<void> {
    const channel = await SessionStore.open(office, "C123");
    await channel.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: "1000.0001" });
    await channel.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[alice]: run the build" }],
      timestamp: 1,
    });
    await channel.appendMessage(
      fauxAssistantMessage(fauxToolCall("bash", { command: "make" }, { id: "call-1" }), {
        stopReason: "toolUse",
      }),
    );
    await channel.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "build hash 4f2a9c" }],
      isError: false,
      timestamp: 3,
    });
    await channel.appendMessage(fauxAssistantMessage("done"));
    await channel.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: "1000.0003" });
    await channel.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[bob]: later unrelated work" }],
      timestamp: 5,
    });
    await channel.close();
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "run the build",
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "bot",
        text: "done",
        isMessagingBot: true,
        replyTo: "1000.0001",
        sessionKey: "C123",
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U2",
        userName: "bob",
        text: "later unrelated work",
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        threadTs: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "what was that output?",
      },
      {
        date: "2026-05-01T00:00:04.000Z",
        ts: "1000.0005",
        threadTs: "1000.0001",
        user: "U3",
        userName: "carol",
        text: "earlier thread remark",
      },
      {
        date: "2026-05-01T00:00:05.000Z",
        ts: "1000.0006",
        threadTs: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "and the hash?",
      },
    ]);
  }

  test("a thread under a channel run, or under its trigger, forks that run with its tool output", async () => {
    await channelWithRuns();
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:06.000Z"),
    });
    const channelId = (await SessionStore.list(office)).find((session) => session.root)?.id;

    for (const [key, current] of [
      ["C123:1000.0002", "1000.0004"],
      ["C123:1000.0001", "1000.0006"],
    ] as const) {
      await manager.resolveSessionScope({ office, sessionKey: key, currentMessageId: current });
      const text = await readContextText(key);
      expect(text).toContain("build hash 4f2a9c");
      expect(text).not.toContain("later unrelated work");
      expect(text).not.toContain("and the hash?");
      expect(
        (await SessionStore.list(office)).find((session) => session.key === key)?.parentSessionId,
      ).toBe(channelId);
    }
    expect(await readContextText("C123:1000.0001")).toContain("[carol]: earlier thread remark");
  });

  test("a forked thread keeps a new message identical to its inherited chat history", async () => {
    await channelWithRuns();
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:07.000Z"),
    });
    const key = "C123:1000.0001";
    await manager.resolveSessionScope({ office, sessionKey: key, currentMessageId: "1000.0006" });
    appendFileSync(
      office.logPath,
      `${JSON.stringify({
        date: "2026-05-01T00:00:06.000Z",
        ts: "1000.0007",
        threadTs: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "earlier thread remark",
      })}\n`,
    );
    await syncViaRuntimePath(manager, office, key, key);
    const text = await readContextText(key);
    expect(text.match(/: earlier thread remark/g)).toHaveLength(2);
    expect(text).toContain("build hash 4f2a9c");
    expect(await readContextText("C123")).not.toContain("earlier thread remark");

    await syncViaRuntimePath(manager, office, key, key);
    expect(await readContextText(key)).toBe(text);
  });

  test("a thread no run caused starts from its root and its own replies alone", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "top-level context",
      },
      {
        date: "2026-05-01T00:01:00.000Z",
        ts: "2000.0001",
        user: "U2",
        userName: "bob",
        text: "thread root",
      },
      {
        date: "2026-05-01T00:01:01.000Z",
        ts: "2000.0002",
        threadTs: "2000.0001",
        user: "U3",
        userName: "carol",
        text: "thread remark",
      },
      {
        date: "2026-05-01T00:01:02.000Z",
        ts: "2000.0003",
        threadTs: "2000.0001",
        user: "U2",
        userName: "bob",
        text: "current thread message",
      },
    ]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:01:03.000Z"),
    });

    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123:2000.0001",
      currentMessageId: "2000.0003",
    });

    expect(scope.threadRootMessage?.text).toBe("thread root");
    const text = await readContextText(scope.key);
    expect(text).toContain("[bob]: thread root");
    expect(text).toContain("[carol]: thread remark");
    expect(text).not.toContain("top-level context");
    expect(text).not.toContain("current thread message");
  });

  test("sync adds other bots' messages as chat lines and leaves run answers to their sessions", async () => {
    await (await SessionStore.open(office, "C123")).close();
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "bot:B1",
        userName: "deploybot",
        text: "deploy finished",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "bot",
        text: "answer from a thread run",
        isMessagingBot: true,
        replyTo: "999.0001",
        sessionKey: "C123:999.0001",
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "bot",
        text: "Stopped.",
        isMessagingBot: true,
      },
    ]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });

    await syncViaRuntimePath(manager, office, "C123", "C123");

    const inspection = await inspectSession("C123");
    const messages = (await inspection.buildSessionContext()).messages;
    expect(messages.every((message) => message.role === "user")).toBe(true);
    const text = await readContextText("C123");
    expect(text).toContain("[deploybot]: deploy finished");
    expect(text).toContain("[bot]: Stopped.");
    expect(text).not.toContain("answer from a thread run");
  });

  test.each(["alice", "bob"])(
    "keeps a later identical message from %s and does not replay it on the next sync",
    async (userName) => {
      const first = {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "thanks",
        isMessagingBot: false,
      };
      writeLog([first]);
      const manager = new ChatHistorySync({
        isCommandText,
        now: () => new Date("2026-05-02T00:00:03.000Z"),
      });
      await manager.resolveSessionScope({ office, sessionKey: "C123" });
      writeLog([
        first,
        {
          ...first,
          date: "2026-05-02T00:00:00.000Z",
          ts: "2000.0001",
          user: userName === "alice" ? "U1" : "U2",
          userName,
        },
        {
          ...first,
          date: "2026-05-02T00:00:01.000Z",
          ts: "2000.0002",
          text: "different",
        },
      ]);

      await syncViaRuntimePath(manager, office, "C123", "C123");
      const firstSync = await readContextText("C123");
      expect(firstSync.match(/: thanks/g)).toHaveLength(2);
      expect(firstSync).toContain(`[${userName}]: thanks`);
      expect(firstSync).toContain("different");

      await syncViaRuntimePath(manager, office, "C123", "C123");
      expect(await readContextText("C123")).toBe(firstSync);
    },
  );

  test("a run-cause without an admitted user message does not hide the trigger from history", async () => {
    const trigger = {
      date: "2026-05-01T00:00:00.000Z",
      ts: "1000.0001",
      user: "U1",
      userName: "alice",
      text: "request before authentication failed",
      isMessagingBot: false,
    };
    writeLog([trigger]);
    const manager = new ChatHistorySync({
      isCommandText,
      maxTopLevelMessages: 1,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    await manager.resolveSessionScope({
      office,
      sessionKey: "C123",
      currentMessageId: trigger.ts,
    });
    const session = await SessionStore.open(office, "C123");
    try {
      await session.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: trigger.ts });
    } finally {
      await session.close();
    }
    writeLog([trigger, { ...trigger, ts: "1000.0002", text: "other passive history" }]);
    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect(await readContextText("C123")).toContain("other passive history");

    writeLog([trigger]);
    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect(await readContextText("C123")).toContain("request before authentication failed");
  });

  test("run-cause IDs exclude handled prompts without excluding a later identical message", async () => {
    const trigger = {
      date: "2026-05-01T00:00:00.000Z",
      ts: "1000.0001",
      user: "U1",
      userName: "alice",
      text: "thanks",
      isMessagingBot: false,
    };
    writeLog([trigger]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:04.000Z"),
    });
    await manager.resolveSessionScope({
      office,
      sessionKey: "C123",
      currentMessageId: trigger.ts,
    });
    const session = await SessionStore.open(office, "C123");
    try {
      await session.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: trigger.ts });
      await session.appendMessage({
        role: "user",
        content: [{ type: "text", text: "[2026-05-01 00:00:00+00:00] [alice]: thanks" }],
        timestamp: 1,
      });
    } finally {
      await session.close();
    }
    writeLog([trigger, { ...trigger, ts: "1000.0002", text: "between runs" }]);
    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect((await readContextText("C123")).match(/: thanks/g)).toHaveLength(1);

    appendFileSync(office.logPath, `${JSON.stringify({ ...trigger, ts: "1000.0003" })}\n`);
    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect((await readContextText("C123")).match(/: thanks/g)).toHaveLength(2);
  });

  test("syncs passive top-level chat messages into an existing session", async () => {
    const logEntries = [
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "k0",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "k1",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "next one is?",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "bot",
        text: "k2",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:04.000Z",
        ts: "1000.0005",
        user: "U1",
        userName: "alice",
        text: "/pi-session",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:05.000Z",
        ts: "1000.0006",
        user: "U1",
        userName: "alice",
        text: "thread0",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:06.000Z",
        ts: "1000.0007",
        user: "U1",
        userName: "alice",
        text: "thread1",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:07.000Z",
        ts: "1000.0008",
        user: "U1",
        userName: "alice",
        text: "current question",
        isMessagingBot: false,
      },
    ];
    writeLog(logEntries.slice(0, 3));

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:08.000Z"),
    });
    const firstScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0003",
    });
    const session = await SessionStore.open(office, firstScope.key);
    await session.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: "1000.0003" });
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[2026-05-01 00:00:02+00:00] [alice]: next one is?" }],
      timestamp: 1,
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "k2" }],
      api: "platform-history",
      provider: "platform-history",
      model: "platform-history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    await session.close();
    writeLog(logEntries);

    const secondScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0008",
    });
    const syncSession = await SessionStore.open(office, secondScope.key);
    try {
      await manager.syncSessionManager({
        office,
        sessionKey: "C123",
        sessionManager: syncSession,
        currentMessageId: "1000.0008",
      });
    } finally {
      await syncSession.close();
    }

    const text = await readContextText(secondScope.key);
    expect(text).toContain("k0");
    expect(text).toContain("k1");
    expect(text).toContain("k2");
    expect(text).toContain("thread0");
    expect(text).toContain("thread1");
    expect(text).not.toContain("/pi-session");
    expect(text).not.toContain("current question");
    expect((await sessionRaw(secondScope.key)).match(/next one is\?/g)).toHaveLength(1);
    expect((await sessionRaw(secondScope.key)).match(/\bk2\b/g)).toHaveLength(1);
  });

  test("applies the same message cap when syncing an existing top-level session", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "seed",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 2,
      now: () => new Date("2026-05-01T00:00:04.000Z"),
    });
    const firstScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
    });

    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "seed",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "sync0",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "sync1",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "sync2",
        isMessagingBot: false,
      },
    ]);

    const secondScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
    });
    await syncViaRuntimePath(manager, office, "C123", secondScope.key);

    expect(secondScope.key).toBe(firstScope.key);
    const text = await readContextText(secondScope.key);
    expect(text).toContain("seed");
    expect(text).not.toContain("sync0");
    expect(text).toContain("sync1");
    expect(text).toContain("sync2");
  });

  test("a rebuilt log does not replay synced IDs or hide a new identical message", async () => {
    const first = {
      date: "2026-05-01T00:00:00.000Z",
      ts: "1000.0001",
      user: "U1",
      userName: "alice",
      text: "thanks",
      isMessagingBot: false,
    };
    const second = { ...first, ts: "1000.0002", user: "U2", userName: "bob" };
    const watermark = { ...first, ts: "1000.0003", text: "watermark" };
    writeLog([first]);
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    await manager.resolveSessionScope({ office, sessionKey: "C123" });
    writeLog([first, second, watermark]);
    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect((await readContextText("C123")).match(/: thanks/g)).toHaveLength(2);

    writeLog([first, second, { ...first, ts: "1000.0004", user: "U3", userName: "charlie" }]);
    await syncViaRuntimePath(manager, office, "C123", "C123");
    const text = await readContextText("C123");
    expect(text.match(/: thanks/g)).toHaveLength(3);
    expect(text).toContain("[charlie]: thanks");
    expect(text.match(/: watermark/g)).toHaveLength(1);

    await syncViaRuntimePath(manager, office, "C123", "C123");
    expect(await readContextText("C123")).toBe(text);
  });

  test("recovers when log rebuild removes the existing sync watermark", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "seed",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const firstScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
    });

    writeLog([
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "rebuilt history",
        isMessagingBot: false,
      },
    ]);
    appendFileSync(
      join(conversationDir, "log.jsonl"),
      `${JSON.stringify({
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "after rebuild",
        isMessagingBot: false,
      })}\n`,
      "utf-8",
    );

    const secondScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
    });
    await syncViaRuntimePath(manager, office, "C123", secondScope.key);

    expect(secondScope.key).toBe(firstScope.key);
    const text = await readContextText(secondScope.key);
    expect(text).toContain("seed");
    expect(text).toContain("rebuilt history");
    expect(text).toContain("after rebuild");
    expect((await sessionRaw(secondScope.key)).match(/\bseed\b/g)).toHaveLength(1);
  });

  test("recognizes mikan's posted reply as the model's own and never feeds the signature back", async () => {
    const logEntries = [
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "hi",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "bot",
        text: "✓ Look up the greeting\n\nHi! What can I help you with?\n\n_Triggered by @alice_",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "bot",
        text: "Scheduled digest ready.\n\n_Triggered by [event: daily.json]_ · session: https://mikan.example.com/session?token=t",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "hi again",
        isMessagingBot: false,
      },
    ];
    writeLog(logEntries.slice(0, 1));
    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:04.000Z"),
    });
    const firstScope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0001",
    });
    const session = await SessionStore.open(office, firstScope.key);
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[2026-05-01 00:00:00+00:00] [alice]: hi" }],
      timestamp: 1,
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Hi! What can I help you with?\n_Triggered by @alice" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    await session.close();
    writeLog(logEntries);

    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0004",
    });
    const syncSession = await SessionStore.open(office, scope.key);
    try {
      await manager.syncSessionManager({
        office,
        sessionKey: "C123",
        sessionManager: syncSession,
        currentMessageId: "1000.0004",
      });
    } finally {
      await syncSession.close();
    }

    const raw = await sessionRaw(scope.key);
    expect(raw.match(/What can I help you with/g)).toHaveLength(1);
    expect(raw).not.toContain("Look up the greeting");
    expect(raw).toContain("Scheduled digest ready.");
    expect(raw.match(/Triggered by/g)).toHaveLength(1);
  });

  test("does not duplicate user-only bootstrapped history after the first assistant reply", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "u0",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "u1",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "current message",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123",
      currentMessageId: "1000.0003",
    });

    const session = await SessionStore.open(office, scope.key);
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[alice]: current message" }],
      timestamp: 1,
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "u2" }],
      api: "platform-history",
      provider: "platform-history",
      model: "platform-history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });

    expect(await countJsonlEntries(scope.key, (entry) => entry.type === "session")).toBe(1);
    expect(
      await countJsonlEntries(
        scope.key,
        (entry) => entry.type === "custom" && entry.customType === "mikan.chat_sync",
      ),
    ).toBe(1);
    expect((await sessionRaw(scope.key)).match(/\bu0\b/g)).toHaveLength(1);
  });

  test("thread bootstrap sync is a no-op when only the represented root is in scope", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "top-level context",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "2000.0001",
        user: "U1",
        userName: "alice",
        text: "thread root",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "2000.0002",
        threadTs: "2000.0001",
        user: "U1",
        userName: "alice",
        text: "current thread question",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      isCommandText,
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123:2000.0001",
      currentMessageId: "2000.0002",
    });
    const session = await SessionStore.open(office, scope.key);

    await manager.syncSessionManager({
      office,
      sessionKey: "C123:2000.0001",
      sessionManager: session,
      currentMessageId: "2000.0002",
    });

    expect(
      await countJsonlEntries(
        scope.key,
        (entry) => entry.type === "custom" && entry.customType === "mikan.chat_sync",
      ),
    ).toBe(1);
  });

  test("pre-registered thread sessions skip log bootstrap", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "channel history should not leak",
        isMessagingBot: false,
      },
    ]);

    await registerThreadSession({ office, sessionKey: "C123:2000.0001" });

    const manager = new ChatHistorySync({ isCommandText });
    const scope = await resolveScope(manager, {
      office,
      sessionKey: "C123:2000.0001",
    });

    expect(await SessionStore.exists(office, "C123:2000.0001")).toBe(true);
    expect(await sessionRaw(scope.key)).not.toContain("channel history should not leak");
  });
});
