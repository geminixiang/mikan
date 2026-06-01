import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChatSessionManager, registerThreadSession } from "../src/sessions/chat-session-manager.js";
import {
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
} from "../src/sessions/store.js";

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

function readContextText(sessionFile: string): string {
  const session = SessionManager.open(
    sessionFile,
    getChannelSessionDir(conversationDir),
    conversationDir,
  );
  return session
    .buildSessionContext()
    .messages.map((message) =>
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
    .map((line) => JSON.parse(line) as { type?: string; customType?: string })
    .filter(predicate).length;
}

describe("ChatSessionManager", () => {
  test("bootstraps a top-level session from recent log history and excludes current message", async () => {
    writeLog([
      {
        date: "2026-04-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "too old",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "recent question",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0003",
        user: "bot",
        text: "recent answer",
        isBot: true,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "current message",
        isBot: false,
      },
    ]);

    const manager = new ChatSessionManager({
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

    const text = readContextText(scope.contextFile);
    expect(text).toContain("recent question");
    expect(text).toContain("recent answer");
    expect(text).not.toContain("too old");
    expect(text).not.toContain("current message");
  });

  test("bootstraps a thread session from recent top-level log history plus thread history", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "top-level context",
        isBot: false,
      },
      {
        date: "2026-05-01T00:01:00.000Z",
        ts: "2000.0001",
        user: "U2",
        userName: "bob",
        text: "thread root",
        isBot: false,
      },
      {
        date: "2026-05-01T00:01:01.000Z",
        ts: "2000.0002",
        threadTs: "2000.0001",
        user: "bot",
        text: "thread bot reply",
        isBot: true,
      },
      {
        date: "2026-05-01T00:01:02.000Z",
        ts: "2000.0003",
        threadTs: "2000.0001",
        user: "U2",
        userName: "bob",
        text: "current thread message",
        isBot: false,
      },
    ]);

    const manager = new ChatSessionManager({
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
    const text = readContextText(scope.contextFile);
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
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "thread1",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "thread2",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "thread3",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:04.000Z",
        ts: "1000.0005",
        user: "U1",
        userName: "alice",
        text: "next one is?",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:05.000Z",
        ts: "1000.0006",
        user: "bot",
        text: "thread4",
        isBot: true,
      },
      {
        date: "2026-05-01T00:00:06.000Z",
        ts: "1000.0007",
        threadTs: "1000.0004",
        user: "U1",
        userName: "alice",
        text: "current thread question",
        isBot: false,
      },
    ]);

    const manager = new ChatSessionManager({
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

    const text = readContextText(scope.contextFile);
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
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "k1",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "next one is?",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:03.000Z",
        ts: "1000.0004",
        user: "bot",
        text: "k2",
        isBot: true,
      },
      {
        date: "2026-05-01T00:00:04.000Z",
        ts: "1000.0005",
        user: "U1",
        userName: "alice",
        text: "/pi-session",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:05.000Z",
        ts: "1000.0006",
        user: "U1",
        userName: "alice",
        text: "thread0",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:06.000Z",
        ts: "1000.0007",
        user: "U1",
        userName: "alice",
        text: "thread1",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:07.000Z",
        ts: "1000.0008",
        user: "U1",
        userName: "alice",
        text: "current question",
        isBot: false,
      },
    ];
    writeLog(logEntries.slice(0, 3));

    const manager = new ChatSessionManager({
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
    const session = openManagedSession(
      firstScope.contextFile,
      firstScope.sessionDir,
      conversationDir,
    );
    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[2026-05-01 00:00:02+00:00] [alice]: next one is?" }],
      timestamp: 1,
    });
    session.appendMessage({
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
    writeLog(logEntries);

    const secondScope = await manager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0008",
    });

    const text = readContextText(secondScope.contextFile);
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

  test("does not duplicate user-only bootstrapped history after the first assistant reply", async () => {
    writeLog([
      {
        date: "2026-05-01T00:00:00.000Z",
        ts: "1000.0001",
        user: "U1",
        userName: "alice",
        text: "u0",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "1000.0002",
        user: "U1",
        userName: "alice",
        text: "u1",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "1000.0003",
        user: "U1",
        userName: "alice",
        text: "current message",
        isBot: false,
      },
    ]);

    const manager = new ChatSessionManager({
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

    const session = openManagedSession(scope.contextFile, scope.sessionDir, conversationDir);
    session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[alice]: current message" }],
      timestamp: 1,
    });
    session.appendMessage({
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
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:01.000Z",
        ts: "2000.0001",
        user: "U1",
        userName: "alice",
        text: "thread root",
        isBot: false,
      },
      {
        date: "2026-05-01T00:00:02.000Z",
        ts: "2000.0002",
        threadTs: "2000.0001",
        user: "U1",
        userName: "alice",
        text: "current thread question",
        isBot: false,
      },
    ]);

    const manager = new ChatSessionManager({
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
    const session = openManagedSession(scope.contextFile, scope.sessionDir, conversationDir);

    manager.syncSessionManager({
      conversationDir,
      sessionKey: "C123:2000.0001",
      sessionManager: session,
      currentMessageId: "2000.0002",
    });

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
        isBot: false,
      },
    ]);

    registerThreadSession({ conversationDir, sessionKey: "C123:2000.0001", cwd: conversationDir });

    const manager = new ChatSessionManager();
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
