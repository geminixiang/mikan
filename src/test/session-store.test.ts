import { officeSessionsDir } from "../office/index.js";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionStore } from "../harness/index.js";
import { ChatHistorySync } from "../sessions/chat-history-sync.js";
import { shouldRotateTopLevelSession } from "../sessions/store.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  createNewSessionFile,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
  resolveManagedSessionFile,
  resolveSessionFile,
  tryResolveCurrentSession,
  tryResolveThreadSession,
} from "../sessions/store.js";

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
    .map((line) => JSON.parse(line) as { kind?: string })
    .filter((entry) => entry.kind === "header").length;
}

async function seedManagedSession(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  text: string,
): Promise<string> {
  createManagedSessionFileAtPath(sessionFile, cwd);
  const sessionManager = await openManagedSession(sessionFile, cwd);
  await sessionManager.appendMessage(makeUserMessage(text));
  await sessionManager.appendMessage(makeAssistantMessage(`${text} reply`));
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
  header.createdAt = new Date(timestamp).getTime();
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

describe("officeSessionsDir", () => {
  test("channel session key uses shared sessions directory", () => {
    expect(officeSessionsDir(channelDir)).toBe(join(channelDir, "sessions"));
  });

  test("thread session key also uses shared sessions directory", () => {
    expect(officeSessionsDir(channelDir)).toBe(join(channelDir, "sessions"));
  });
});

describe("getThreadSessionFile", () => {
  test("maps thread session key to a fixed jsonl file", () => {
    expect(getThreadSessionFile(channelDir, "C123:1000.0001")).toBe(
      join(channelDir, "sessions", "1000.0001.jsonl"),
    );
  });

  test.each(["C123:../other", "C123:foo/bar", String.raw`C123:foo\bar`, "C123:bad\u0000id"])(
    "rejects path-dangerous thread session key %j",
    (sessionKey) => {
      expect(() => getThreadSessionFile(channelDir, sessionKey)).toThrow();
    },
  );
});

describe("resolveSessionFile", () => {
  test("creates new placeholder session file when none exists", () => {
    const sessionDir = officeSessionsDir(channelDir);
    const file = resolveSessionFile(sessionDir);
    expect(existsSync(file)).toBe(true);
    expect(file).toContain(join(channelDir, "sessions"));
  });

  test("ignores a current pointer that escapes the session directory", () => {
    const sessionDir = officeSessionsDir(channelDir);
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(channelDir, "outside.jsonl");
    createManagedSessionFileAtPath(outside, channelDir);
    writeFileSync(join(sessionDir, "current"), "../outside.jsonl");

    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
  });

  test("ignores a current pointer whose target is a symlink", () => {
    const sessionDir = officeSessionsDir(channelDir);
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(channelDir, "outside.jsonl");
    createManagedSessionFileAtPath(outside, channelDir);
    symlinkSync(outside, join(sessionDir, "linked.jsonl"));
    writeFileSync(join(sessionDir, "current"), "linked.jsonl");

    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
  });

  test("returns existing current session file on second call", () => {
    const sessionDir = officeSessionsDir(channelDir);
    const file1 = resolveSessionFile(sessionDir);
    SessionStore.writeHeaderFile(file1, channelDir);
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
    const sessionDir = officeSessionsDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(threadFile, "", "utf-8");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("rejects a thread file symlink that targets another directory", () => {
    const sessionDir = officeSessionsDir(channelDir);
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(channelDir, "outside-thread.jsonl");
    createManagedSessionFileAtPath(outside, channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    symlinkSync(outside, threadFile);

    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("returns fixed thread file path when a valid session exists", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    const created = await seedManagedSession(threadFile, sessionDir, channelDir, "thread msg");
    expect(tryResolveThreadSession(threadFile)).toBe(created);
    expect(readFileSync(created, "utf-8")).toContain("thread msg");
  });
});

describe("resolveChannelSessionFile", () => {
  test("returns null when no channel session exists", () => {
    expect(resolveChannelSessionFile(channelDir)).toBeNull();
  });

  test("returns current channel session file when it exists", () => {
    const sessionDir = officeSessionsDir(channelDir);
    const created = createManagedSessionFile(sessionDir, channelDir);
    expect(resolveChannelSessionFile(channelDir)).toBe(created);
  });
});

describe("managed session initialization", () => {
  test("channel session filename uses a short UUID suffix", () => {
    const sessionDir = officeSessionsDir(channelDir);
    const sessionFile = createManagedSessionFile(sessionDir, channelDir);
    const filename = sessionFile.split("/").pop()!;
    const suffix = filename.replace(".jsonl", "").split("_").pop()!;

    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  test("creates a channel session with the provided cwd", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const sessionFile = resolveManagedSessionFile(sessionDir, channelDir);
    const sessionManager = await openManagedSession(sessionFile, channelDir);

    await sessionManager.appendMessage(makeUserMessage("hello"));
    await sessionManager.appendMessage(makeAssistantMessage("hi"));

    const entries = readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string; cwd?: string });
    const header = entries.find((entry) => entry.kind === "header");

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(sessionFile)).toBe(1);
  });

  test("opens a missing managed session file with the provided cwd", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const sessionFile = join(sessionDir, "missing.jsonl");
    const sessionManager = await openManagedSession(sessionFile, channelDir);

    await sessionManager.appendMessage(makeUserMessage("hello"));
    await sessionManager.appendMessage(makeAssistantMessage("hi"));

    const entries = parseSessionEntries(sessionFile);
    const header = entries.find((entry) => entry.kind === "header") as { cwd?: string } | undefined;

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(sessionFile)).toBe(1);
  });

  test("top-level agent runs replace platform-history current with a live session", () => {
    const sessionDir = officeSessionsDir(channelDir);
    mkdirSync(sessionDir, { recursive: true });
    const historyFile = join(sessionDir, "history.jsonl");
    writeFileSync(
      historyFile,
      `${JSON.stringify({
        kind: "header",
        version: 4,
        id: "history",
        createdAt: Date.now(),
        cwd: channelDir,
        metadata: { source: { kind: "platform-history", file: "log.jsonl" } },
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

  test("creates a fixed-path thread session with the provided cwd", async () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const sessionManager = await openManagedSession(threadFile, channelDir);

    await sessionManager.appendMessage(makeUserMessage("hello thread"));
    await sessionManager.appendMessage(makeAssistantMessage("thread reply"));

    const entries = readFileSync(threadFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string; cwd?: string });
    const header = entries.find((entry) => entry.kind === "header");

    expect(header?.cwd).toBe(channelDir);
    expect(countSessionHeaders(threadFile)).toBe(1);
  });
});

describe("fixed thread sessions", () => {
  test("thread session has a different session ID than channel session", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = await openManagedSession(channelFile, channelDir);
    await channelSM.appendMessage(makeUserMessage("hello channel"));
    await channelSM.appendMessage(makeAssistantMessage("hi there"));
    const channelSessionId = channelSM.getSessionId();

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = await openManagedSession(threadFile, channelDir);
    await threadSM.appendMessage(makeUserMessage("hello thread"));
    await threadSM.appendMessage(makeAssistantMessage("thread reply"));

    expect(threadSM.getSessionId()).not.toBe(channelSessionId);
    expect(readFileSync(threadFile, "utf-8")).not.toContain("hello channel");
  });

  test("second thread access reuses the same fixed thread file", async () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = await openManagedSession(threadFile, channelDir);
    const threadSessionId = threadSM.getSessionId();

    await threadSM.appendMessage(makeUserMessage("thread msg"));
    await threadSM.appendMessage(makeAssistantMessage("thread reply"));
    await threadSM.close();

    const existing = tryResolveThreadSession(threadFile);
    expect(existing).toBe(threadFile);

    const reopened = await openManagedSession(existing!, channelDir);
    expect(reopened.getSessionId()).toBe(threadSessionId);
    expect(readFileSync(existing!, "utf-8")).toContain("thread msg");
  });

  test("different threads get independent session IDs", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const channelFile = resolveManagedSessionFile(sessionDir, channelDir);
    const channelSM = await openManagedSession(channelFile, channelDir);

    const thread1File = getThreadSessionFile(channelDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(channelDir, "C123:1000.0002");
    createManagedSessionFileAtPath(thread1File, channelDir);
    createManagedSessionFileAtPath(thread2File, channelDir);

    const thread1SM = await openManagedSession(thread1File, channelDir);
    const thread2SM = await openManagedSession(thread2File, channelDir);

    const ids = new Set([
      channelSM.getSessionId(),
      thread1SM.getSessionId(),
      thread2SM.getSessionId(),
    ]);
    expect(ids.size).toBe(3);
  });

  test("fresh thread file can be created without a channel source", async () => {
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile, channelDir);
    const threadSM = await openManagedSession(threadFile, channelDir);
    const entries = (await threadSM.getEntries()).filter((e) => e.type === "message");
    expect(entries.length).toBe(0);
  });
});

describe("top-level session rotation", () => {
  // The biweekly clock rule lives in rotation.ts; the rotation *workflow*
  // (Session Dream → reset → re-run) is the runtime's alone. Scope
  // resolution never rotates — it reuses whatever session is current.
  test("clock rule: rotates across biweekly Sunday buckets, not within one", () => {
    const sessionDir = officeSessionsDir(channelDir);
    const staleFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(staleFile, "2026-01-05T12:00:00.000Z");
    expect(shouldRotateTopLevelSession(staleFile, new Date("2026-03-01T12:00:00.000Z"))).toBe(true);

    rewriteSessionTimestamp(staleFile, "2026-02-23T12:00:00.000Z");
    expect(shouldRotateTopLevelSession(staleFile, new Date("2026-02-28T12:00:00.000Z"))).toBe(
      false,
    );
  });

  test("scope resolution reuses a stale top-level session; rotation is the runtime's call", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const currentFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(currentFile, "2026-01-05T12:00:00.000Z");

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const scope = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
    });

    expect(scope.contextFile).toBe(currentFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(currentFile);
  });

  test("scope resolution reuses stale thread sessions", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    await seedManagedSession(threadFile, sessionDir, channelDir, "thread context");
    rewriteSessionTimestamp(threadFile, "2026-01-05T12:00:00.000Z");

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const scope = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123:1000.0001",
      cwd: channelDir,
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

  test("keeps old log messages out after a runtime rotation reset", async () => {
    // The runtime rotates by calling resetSession (after Session Dream);
    // the fresh session's chat_sync watermark must fence out log messages
    // that predate the reset.
    const sessionDir = officeSessionsDir(channelDir);
    const oldFile = createManagedSessionFile(sessionDir, channelDir);
    rewriteSessionTimestamp(oldFile, "2026-01-05T12:00:00.000Z");
    appendLogMessage({
      ts: "1770163200.000000",
      date: "2026-02-04T00:00:00.000Z",
      text: "old log only",
    });

    const manager = new ChatHistorySync({ now: () => new Date("2026-03-01T12:00:00.000Z") });
    const rotatedFile = await manager.resetSession({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
    });
    const reused = await manager.resolveSessionScope({
      conversationDir: channelDir,
      sessionKey: "C123",
      cwd: channelDir,
    });

    expect(reused.contextFile).toBe(rotatedFile);
    expect(readFileSync(reused.contextFile, "utf-8")).not.toContain("old log only");
    expect(
      parseSessionEntries(reused.contextFile).some(
        (entry) => entry.type === "custom" && entry.customType === "mikan.chat_sync",
      ),
    ).toBe(true);
  });
});

describe("session-scoped /new reset", () => {
  test("channel /new rotates channel current pointer and keeps thread session intact", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const channelFile = createManagedSessionFile(sessionDir, channelDir);
    const originalChannel = await openManagedSession(channelFile, channelDir);
    await originalChannel.appendMessage(makeUserMessage("channel"));
    await originalChannel.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    await seedManagedSession(threadFile, sessionDir, channelDir, "thread");

    const newChannelFile = createManagedSessionFile(sessionDir, channelDir);

    expect(newChannelFile).not.toBe(channelFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(newChannelFile);
    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread");
  });

  test("thread /new resets the same fixed file and keeps channel plus sibling thread intact", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const channelFile = createManagedSessionFile(sessionDir, channelDir);
    const channelSM = await openManagedSession(channelFile, channelDir);
    await channelSM.appendMessage(makeUserMessage("channel"));
    await channelSM.appendMessage(makeAssistantMessage("channel reply"));

    const thread1File = getThreadSessionFile(channelDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(channelDir, "C123:1000.0002");
    await seedManagedSession(thread1File, sessionDir, channelDir, "thread1");
    await seedManagedSession(thread2File, sessionDir, channelDir, "thread2");

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
  test("thread session survives simulated restart via fixed file path", async () => {
    const sessionDir = officeSessionsDir(channelDir);
    const threadFile = getThreadSessionFile(channelDir, "C123:1000.0001");
    await seedManagedSession(threadFile, sessionDir, channelDir, "thread specific");

    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(readFileSync(threadFile, "utf-8")).toContain("thread specific");
  });
});

describe("placeholder sessions", () => {
  test("createNewSessionFile still updates current pointer for channel placeholder files", () => {
    const sessionDir = officeSessionsDir(channelDir);
    const placeholder = createNewSessionFile(sessionDir);
    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
    expect(existsSync(placeholder)).toBe(true);
  });
});
