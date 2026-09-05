import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../harness/index.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatHistorySync, registerThreadSession } from "../sessions/chat-history-sync.js";
import { getThreadSessionFile, openManagedSession } from "../sessions/store.js";

let conversationDir: string;

beforeEach(() => {
  conversationDir = join(
    tmpdir(),
    `chat-session-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  rmSync(conversationDir, { recursive: true, force: true });
});

function writeLog(entries: object[]): void {
  writeFileSync(
    join(conversationDir, "log.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf-8",
  );
}

async function readContextText(sessionFile: string): Promise<string> {
  const session = await SessionStore.inspect(sessionFile);
  const context = await session.buildSessionContext();
  return context.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    )
    .join("\n---\n");
}

function countJsonlEntries(
  sessionFile: string,
  predicate: (entry: { type?: string; customType?: string }) => boolean,
): number {
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = JSON.parse(line) as
        | { kind?: string; type?: string; customType?: string }
        | Array<{ kind?: string; type?: string; customType?: string }>;
      return Array.isArray(parsed) ? parsed : [parsed];
    })
    .map((parsed) => {
      if (parsed.kind === "entry") return parsed;
      if (parsed.kind === "header") return { type: "session" };
      return {};
    })
    .filter(predicate).length;
}

async function syncViaRuntimePath(
  manager: ChatHistorySync,
  dir: string,
  sessionKey: string,
  contextFile: string,
  currentMessageId?: string,
): Promise<void> {
  const session = await openManagedSession(contextFile, dir);
  try {
    await manager.syncSessionManager({
      conversationDir: dir,
      sessionKey,
      sessionManager: session,
      ...(currentMessageId !== undefined ? { currentMessageId } : {}),
    });
  } finally {
    await session.close();
  }
}

describe("ChatHistorySync", () => {
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
      now: () => new Date("2026-05-01T00:00:10.000Z"),
    });
    const freshFile = await manager.resetSession({ conversationDir, sessionKey: "C123" });

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

    await syncViaRuntimePath(manager, conversationDir, "C123", freshFile, "1000.0003");
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
    await syncViaRuntimePath(manager, conversationDir, "C123", freshFile, "1000.0004");
    text = await readContextText(freshFile);
    expect(text).toContain("new message");
    expect(text).not.toContain("late pre-reset message");
  });

  test("reset does not replay late records without a trustworthy event date", async () => {
    writeLog([]);
    const manager = new ChatHistorySync({
      now: () => new Date("2026-05-01T00:00:10.000Z"),
    });
    const freshFile = await manager.resetSession({ conversationDir, sessionKey: "C123" });

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
      conversationDir,
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
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });

    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0004",
    });

    const text = await readContextText(scope.contextFile);
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

    const scope = await new ChatHistorySync({
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    }).resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0002",
    });

    const text = await readContextText(scope.contextFile);
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
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
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

    const session = await openManagedSession(scope.contextFile, conversationDir);
    await manager.syncSessionManager({
      conversationDir,
      sessionKey: "C123",
      sessionManager: session,
      currentMessageId: "1000.0003",
    });
    await session.close();

    const text = await readContextText(scope.contextFile);
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
      recentDays: 7,
      maxTopLevelMessages: 2,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });

    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
    });

    const text = await readContextText(scope.contextFile);
    expect(text).toContain("question");
    expect(text).toContain("One two three");
    expect(countJsonlEntries(scope.contextFile, (entry) => entry.type === "message")).toBe(2);
  });

  test("bootstraps a thread session from recent top-level log history plus thread history", async () => {
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
        date: "2026-05-01T00:01:00.000Z",
        ts: "2000.0001",
        user: "U2",
        userName: "bob",
        text: "thread root",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:01:01.000Z",
        ts: "2000.0002",
        threadTs: "2000.0001",
        user: "bot",
        text: "thread bot reply",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:01:02.000Z",
        ts: "2000.0003",
        threadTs: "2000.0001",
        user: "U2",
        userName: "bob",
        text: "current thread message",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:01:03.000Z"),
    });

    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
      currentMessageId: "2000.0003",
    });

    expect(scope.contextFile).toBe(getThreadSessionFile(conversationDir, "C123:2000.0001"));
    expect(scope.threadRootMessage?.text).toBe("thread root");
    const text = await readContextText(scope.contextFile);
    expect(text).toContain("top-level context");
    expect(text).toContain("thread root");
    expect(text).toContain("thread bot reply");
    expect(text).not.toContain("current thread message");
  });

  test("thread bootstrap excludes top-level messages after the thread root", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "thread0",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "thread1",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "thread2",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "thread3",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:04.000Z",
        ts: "1000.0005",
        user: "U1",
        userName: "alice",
        text: "next one is?",
        isMessagingBot: false,
      },
      {
        date: "2026-05-01T00:00:05.000Z",
        ts: "1000.0006",
        user: "bot",
        text: "thread4",
        isMessagingBot: true,
      },
      {
        date: "2026-05-01T00:00:06.000Z",
        ts: "1000.0007",
        threadTs: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "current thread question",
        isMessagingBot: false,
      },
    ]);

    const manager = new ChatHistorySync({
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:07.000Z"),
    });
    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123:1000.0004",
      cwd: conversationDir,
      currentMessageId: "1000.0007",
    });

    const text = await readContextText(scope.contextFile);
    expect(text).toContain("thread0");
    expect(text).toContain("thread1");
    expect(text).toContain("thread2");
    expect(text).toContain("thread3");
    expect(text).not.toContain("next one is?");
    expect(text).not.toContain("thread4");
    expect(text).not.toContain("current thread question");
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
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:08.000Z"),
    });
    const firstScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0003",
    });
    const session = await openManagedSession(firstScope.contextFile, conversationDir);
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

    // Scope resolution only materializes; the incremental sync is the
    // runtime's single per-event call through syncSessionManager.
    const secondScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0008",
    });
    const syncSession = await openManagedSession(secondScope.contextFile, conversationDir);
    try {
      await manager.syncSessionManager({
        conversationDir,
        sessionKey: "C123",
        sessionManager: syncSession,
        currentMessageId: "1000.0008",
      });
    } finally {
      await syncSession.close();
    }

    const text = await readContextText(secondScope.contextFile);
    expect(text).toContain("k0");
    expect(text).toContain("k1");
    expect(text).toContain("k2");
    expect(text).toContain("thread0");
    expect(text).toContain("thread1");
    expect(text).not.toContain("/pi-session");
    expect(text).not.toContain("current question");
    expect(readFileSync(secondScope.contextFile, "utf-8").match(/next one is\?/g)).toHaveLength(1);
    expect(readFileSync(secondScope.contextFile, "utf-8").match(/\bk2\b/g)).toHaveLength(1);
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
      recentDays: 7,
      maxTopLevelMessages: 2,
      now: () => new Date("2026-05-01T00:00:04.000Z"),
    });
    const firstScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
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

    const secondScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
    });
    await syncViaRuntimePath(manager, conversationDir, "C123", secondScope.contextFile);

    expect(secondScope.contextFile).toBe(firstScope.contextFile);
    const text = await readContextText(secondScope.contextFile);
    expect(text).toContain("seed");
    expect(text).not.toContain("sync0");
    expect(text).toContain("sync1");
    expect(text).toContain("sync2");
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
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const firstScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
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

    const secondScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
    });
    await syncViaRuntimePath(manager, conversationDir, "C123", secondScope.contextFile);

    expect(secondScope.contextFile).toBe(firstScope.contextFile);
    const text = await readContextText(secondScope.contextFile);
    expect(text).toContain("seed");
    expect(text).toContain("rebuilt history");
    expect(text).toContain("after rebuild");
    expect(readFileSync(secondScope.contextFile, "utf-8").match(/\bseed\b/g)).toHaveLength(1);
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
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0003",
    });

    const session = await openManagedSession(scope.contextFile, conversationDir);
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

    expect(countJsonlEntries(scope.contextFile, (entry) => entry.type === "session")).toBe(1);
    expect(
      countJsonlEntries(
        scope.contextFile,
        (entry) => entry.type === "custom" && entry.customType === "mikan.chat_sync",
      ),
    ).toBe(1);
    expect(readFileSync(scope.contextFile, "utf-8").match(/\bu0\b/g)).toHaveLength(1);
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
      recentDays: 7,
      maxTopLevelMessages: 20,
      now: () => new Date("2026-05-01T00:00:03.000Z"),
    });
    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
      currentMessageId: "2000.0002",
    });
    const session = await openManagedSession(scope.contextFile, conversationDir);

    const report = await manager.syncSessionManager({
      conversationDir,
      sessionKey: "C123:2000.0001",
      sessionManager: session,
      currentMessageId: "2000.0002",
    });

    // Nothing new to sync: the report says so through the interface, and the
    // bootstrap's single watermark entry is the only one on disk.
    expect(report).toEqual({ appended: 0 });
    expect(
      countJsonlEntries(
        scope.contextFile,
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

    registerThreadSession({ conversationDir, sessionKey: "C123:2000.0001", cwd: conversationDir });

    const manager = new ChatHistorySync();
    const scope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    expect(scope.contextFile).toBe(getThreadSessionFile(conversationDir, "C123:2000.0001"));
    expect(existsSync(scope.contextFile)).toBe(true);
    expect(readFileSync(scope.contextFile, "utf-8")).not.toContain(
      "channel history should not leak",
    );
  });
});
