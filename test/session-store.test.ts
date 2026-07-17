import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { ChatHistorySync } from "../src/sessions/chat-history-sync.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  createNewSessionFile,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
  resolveManagedSessionFile,
  resolveSessionFile,
  tryResolveCurrentSession,
  tryResolveThreadSession,
} from "../src/sessions/store.js";

let channelDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  channelDir = join(
    tmpdir(),
    `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(channelDir, { recursive: true });
});

afterEach(() => {
  rmSync(channelDir, { recursive: true, force: true });
});

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: nextTimestamp++,
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    timestamp: nextTimestamp++,
  };
}

function countSessionHeaders(sessionFile: string): number {
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string })
    .filter((entry) => entry.type === "session").length;
}

function seedManagedSession(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  text: string,
): string {
  createManagedSessionFileAtPath(sessionFile, cwd);
  const sessionManager = openManagedSession(sessionFile, cwd);
  sessionManager.appendMessage(makeUserMessage(text));
  sessionManager.appendMessage(makeAssistantMessage(`${text} reply`));
  return sessionFile;
}

function parseSessionEntries(sessionFile: string): Array<Record<string, unknown>> {
  return readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rewriteSessionTimestamp(sessionFile: string, timestamp: string): void {
  const lines = readFileSync(sessionFile, "utf-8").split("\n");
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  header.timestamp = timestamp;
  lines[0] = JSON.stringify(header);
  writeFileSync(sessionFile, lines.join("\n"));
}

function appendLogMessage(options: {
  ts: string;
  date: string;
  text: string;
  threadTs?: string;
  isMessagingBot?: boolean;
}): void {
  writeFileSync(
    join(channelDir, "log.jsonl"),
    `${JSON.stringify({
      date: options.date,
      ts: options.ts,
      threadTs: options.threadTs,
      user: options.isMessagingBot ? "bot" : "U1",
      userName: options.isMessagingBot ? undefined : "alice",
      text: options.text,
      isMessagingBot: options.isMessagingBot === true,
    })}\n`,
    { flag: "a" },
  );
}

describe("getChannelSessionDir", () => {
  test("channel session key uses shared sessions directory", () => {
    expect(getChannelSessionDir(channelDir)).toBe(join(channelDir, "sessions"));
  });

  test("thread session key also uses shared sessions directory", () => {
    expect(getChannelSessionDir(channelDir)).toBe(join(channelDir, "sessions"));
  });
});

describe("getThreadSessionFile", () => {
  test("maps thread session key to a fixed jsonl file", () => {
    expect(getThreadSessionFile(channelDir, "C123:1000.0001")).toBe(
      join(channelDir, "sessions", "1000.0001.jsonl"),
    );
  });
});

describe("resolveSessionFile", () => {
  test("creates new placeholder session file when none exists", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const file = resolveSessionFile(sessionDir);
    expect(existsSync(file)).toBe(true);
    expect(file).toContain(join(channelDir, "sessions"));
  });

  test("returns existing current session file on second call", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const file1 = resolveSessionFile(sessionDir);
    writeFileSync(file1, '{"type":"session","id":"test"}\n');
    const file2 = resolveSessionFile(sessionDir);
    expect(file2).toBe(file1);
  });
});

describe("tryResolveThreadSession", () => {
  test("returns null when no thread session file exists", () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("ignores empty placeholder files without a valid header", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(threadFile, "", "utf-8");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("returns fixed thread file path when a valid session exists", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    const created = seedManagedSession(threadFile, sessionDir, channelDir, "thread msg");
    expect(tryResolveThreadSession(threadFile)).toBe(created);
    expect(readFileSync(created, "utf-8")).toContain("thread msg");
  });
});

describe("resolveChannelSessionFile", () => {
  test("returns null when no channel session exists", () => {
    expect(resolveChannelSessionFile(channelDir)).toBeNull();
  });

  test("returns current channel session file when it exists", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const created = createManagedSessionFile(sessionDir, channelDir);
    expect(resolveChannelSessionFile(channelDir)).toBe(created);
  });
});

describe("managed session initialization", () => {
  test("channel session filename uses a short UUID suffix", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const sessionFile = createManagedSessionFile(sessionDir, channelDir);
    const filename = sessionFile.split("/").pop()!;
    const suffix = filename.replace(".jsonl", "").split("_").pop()!;

    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  test("creates a channel session with the provided cwd", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const sessionFile = resolveManagedSessionFile(sessionDir, channelDir);
    const sessionManager = openManagedSession(sessionFile, channelDir);

    sessionManager.appendMessage(makeUserMessage("hello"));
    sessionManager.appendMessage(makeAssistantMessage("hi"));

    const entries = readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; cwd?: string });
    const header = entries.find((entry) => entry.type === "session");

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(sessionFile)).toBe(1);
  });

  test("opens a missing managed session file with the provided cwd", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const sessionFile = join(sessionDir, "missing.jsonl");
    const sessionManager = openManagedSession(sessionFile, channelDir);

    sessionManager.appendMessage(makeUserMessage("hello"));
    sessionManager.appendMessage(makeAssistantMessage("hi"));

    const entries = parseSessionEntries(sessionFile);
    const header = entries.find((entry) => entry.type === "session") as
      | { cwd?: string }
      | undefined;

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(sessionFile)).toBe(1);
  });

  test("top-level agent runs replace platform-history current with a live session", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    mkdirSync(sessionDir, { recursive: true });
    const historyFile = join(sessionDir, "history.jsonl");
    writeFileSync(
      historyFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "history",
        timestamp: new Date().toISOString(),
        cwd: channelDir,
        source: { kind: "platform-history", file: "log.jsonl" },
      })}\n`,
    );
    writeFileSync(join(sessionDir, "current"), "history.jsonl");

    const liveFile = resolveManagedSessionFile(sessionDir, channelDir);

    expect(liveFile).not.toBe(historyFile);
    expect(readFileSync(join(sessionDir, "current"), "utf-8").trim()).toBe(
      liveFile.split("/").pop(),
    );
    expect(readFileSync(liveFile, "utf-8")).not.toContain("platform-history");
  });

  test("creates a fixed-path thread session with the provided cwd", () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const sessionManager = openManagedSession(threadFile, channelDir);

    sessionManager.appendMessage(makeUserMessage("hello thread"));
    sessionManager.appendMessage(makeAssistantMessage("thread reply"));

    const entries = readFileSync(threadFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; cwd?: string });
    const header = entries.find((entry) => entry.type === "session");

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(threadFile)).toBe(1);
  });
});

describe("fixed thread sessions", () => {
  test("thread session has a different session ID than channel session", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, channelDir);
    channelSM.appendMessage(makeUserMessage("hello channel"));
    channelSM.appendMessage(makeAssistantMessage("hi there"));
    const channelSessionId = channelSM.getSessionId();

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = openManagedSession(threadFile, channelDir);
    threadSM.appendMessage(makeUserMessage("hello thread"));
    threadSM.appendMessage(makeAssistantMessage("thread reply"));

    expect(threadSM.getSessionId()).not.toBe(channelSessionId);
    expect(readFileSync(threadFile, "utf-8")).not.toContain("hello channel");
  });

  test("second thread access reuses the same fixed thread file", () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = openManagedSession(threadFile, channelDir);
    const threadSessionId = threadSM.getSessionId();

    threadSM.appendMessage(makeUserMessage("thread msg"));
    threadSM.appendMessage(makeAssistantMessage("thread reply"));

    const existing = tryResolveThreadSession(threadFile);
    expect(existing).toBe(threadFile);

    const reopened = openManagedSession(existing!, channelDir);
    expect(reopened.getSessionId()).toBe(threadSessionId);
    expect(readFileSync(existing!, "utf-8")).toContain("thread msg");
  });

  test("different threads get independent session IDs", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, channelDir);

    const thread1File = getThreadSessionFile(channelDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(channelDir, "C123:1000.0002");
    createManagedSessionFileAtPath(thread1File, channelDir);
    createManagedSessionFileAtPath(thread2File, channelDir);

    const thread1SM = openManagedSession(thread1File, channelDir);
    const thread2SM = openManagedSession(thread2File, channelDir);

    const ids = new Set([
      channelSM.getSessionId(),
      thread1SM.getSessionId(),
      thread2SM.getSessionId(),
    ]);
    expect(ids.size).toBe(3);
  });

  test("fresh thread file can be created without a channel source", () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = openManagedSession(threadFile, channelDir);
    const entries = threadSM.getEntries().filter((e: { type: string }) => e.type === "message");
    expect(entries.length).toBe(0);
  });
});

describe("top-level session rotation", () => {
  test("rotates shared top-level sessions on biweekly Sunday bucket changes", async () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const oldFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(oldFile, "2026-01-05T12:00:00.000Z");
    const oldSession = openManagedSession(oldFile, channelDir);
    oldSession.appendMessage(makeUserMessage("stale active context"));

    appendLogMessage({
      ts: "1771027200.000000",
      date: "2026-02-14T00:00:00.000Z",
      text: "outside two week bootstrap",
    });
    appendLogMessage({
      ts: "1771545600.000000",
      date: "2026-02-20T00:00:00.000Z",
      text: "recent bootstrap context",
    });

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const scope = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
      rotateTopLevelSession: true,
    });

    expect(scope.contextFile).not.toBe(oldFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(scope.contextFile);
    const content = readFileSync(scope.contextFile, "utf-8");
    expect(content).toContain("recent bootstrap context");
    expect(content).not.toContain("outside two week bootstrap");
    expect(content).not.toContain("stale active context");
  });

  test("does not rotate top-level sessions inside the same biweekly bucket", async () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const currentFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(currentFile, "2026-02-23T12:00:00.000Z");

    const manager = new ChatHistorySync({ now: () => new Date("2026-02-28T12:00:00.000Z") });
    const scope = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
      rotateTopLevelSession: true,
    });

    expect(scope.contextFile).toBe(currentFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(currentFile);
  });

  test("does not rotate stale top-level sessions when rotation policy is disabled", async () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const currentFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(currentFile, "2026-01-05T12:00:00.000Z");

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const scope = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
      rotateTopLevelSession: false,
    });

    expect(scope.contextFile).toBe(currentFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(currentFile);
  });

  test("does not rotate thread sessions", async () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    seedManagedSession(threadFile, sessionDir, channelDir, "thread context");
    rewriteSessionTimestamp(threadFile, "2026-01-05T12:00:00.000Z");

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const scope = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123:1000.0001",
      cwd: channelDir,
      rotateTopLevelSession: true,
    });

    expect(scope.contextFile).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread context");
  });

  test("keeps old top-level context out of thread sessions after bootstrap", async () => {
    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    appendLogMessage({
      ts: "1770163200.000000",
      date: "2026-02-04T00:00:00.000Z",
      text: "old top-level context",
    });
    appendLogMessage({
      ts: "1771545600.000000",
      date: "2026-02-20T00:00:00.000Z",
      text: "thread root",
    });
    appendLogMessage({
      ts: "1771545601.000000",
      date: "2026-02-20T00:00:01.000Z",
      text: "thread reply",
      threadTs: "1771545600.000000",
    });

    const created = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123:1771545600.000000",
      cwd: channelDir,
    });
    const reused = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123:1771545600.000000",
      cwd: channelDir,
    });

    expect(reused.contextFile).toBe(created.contextFile);
    const content = readFileSync(reused.contextFile, "utf-8");
    expect(content).toContain("thread root");
    expect(content).toContain("thread reply");
    expect(content).not.toContain("old top-level context");
  });

  test("keeps old log messages out after rotation sync", async () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const oldFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(oldFile, "2026-01-05T12:00:00.000Z");
    appendLogMessage({
      ts: "1770163200.000000",
      date: "2026-02-04T00:00:00.000Z",
      text: "old log only",
    });

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const rotated = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
      rotateTopLevelSession: true,
    });
    rewriteSessionTimestamp(rotated.contextFile, "2026-03-01T12:00:00.000Z");
    const reused = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
      rotateTopLevelSession: true,
    });

    expect(reused.contextFile).toBe(rotated.contextFile);
    expect(readFileSync(reused.contextFile, "utf-8")).not.toContain("old log only");
    expect(
      parseSessionEntries(reused.contextFile).some(
        (entry) => entry.type === "custom" && entry.customType === "mikan.chat_sync",
      ),
    ).toBe(true);
  });
});

describe("session-scoped /new reset", () => {
  test("channel /new rotates channel current pointer and keeps thread session intact", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = createManagedSessionFile(sessionDir, channelDir);
    const originalChannel = openManagedSession(channelFile, channelDir);
    originalChannel.appendMessage(makeUserMessage("channel"));
    originalChannel.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    seedManagedSession(threadFile, sessionDir, channelDir, "thread");

    const newChannelFile = createManagedSessionFile(sessionDir, channelDir);

    expect(newChannelFile).not.toBe(channelFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(newChannelFile);
    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread");
  });

  test("thread /new resets the same fixed file and keeps channel plus sibling thread intact", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const channelFile = createManagedSessionFile(sessionDir, channelDir);
    const channelSM = openManagedSession(channelFile, channelDir);
    channelSM.appendMessage(makeUserMessage("channel"));
    channelSM.appendMessage(makeAssistantMessage("channel reply"));

    const thread1File = getThreadSessionFile(channelDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(channelDir, "C123:1000.0002");
    seedManagedSession(thread1File, sessionDir, channelDir, "thread1");
    seedManagedSession(thread2File, sessionDir, channelDir, "thread2");

    createManagedSessionFileAtPath(thread1File, channelDir);

    expect(tryResolveThreadSession(thread1File)).toBe(thread1File);
    expect(readFileSync(thread1File, "utf-8")).not.toContain("thread1");
    expect(readFileSync(thread2File, "utf-8")).toContain("thread2");
    expect(readFileSync(resolveManagedSessionFile(sessionDir, channelDir), "utf-8")).toContain(
      "channel",
    );
    expect(countSessionHeaders(thread1File)).toBe(1);
  });
});

describe("persistence across restart", () => {
  test("thread session survives simulated restart via fixed file path", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    seedManagedSession(threadFile, sessionDir, channelDir, "thread specific");

    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread specific");
  });
});

describe("placeholder sessions", () => {
  test("createNewSessionFile still updates current pointer for channel placeholder files", () => {
    const sessionDir = getChannelSessionDir(channelDir);
    const placeholder = createNewSessionFile(sessionDir);
    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
    expect(existsSync(placeholder)).toBe(true);
  });
});
