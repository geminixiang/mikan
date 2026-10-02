import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionStore } from "../sessions/session-store.js";
import { ChatHistorySync } from "../sessions/chat-history-sync.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getThreadSessionFile,
  resolveManagedSessionFile,
  tryResolveCurrentSession,
  tryResolveThreadSession,
} from "../sessions/store.js";
import { isCommandText } from "../adapters/commands/manifest.js";

let root: string;
let office: Office;
let channelDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  root = mkdtempSync(join(tmpdir(), "session-store-test-"));
  office = createWorkspace({ root: join(root, "workspace"), stateDir: join(root, "state") }).office(
    createOfficeAddress("slack", "C123"),
  );
  channelDir = office.dir;
  mkdirSync(channelDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

async function sessionText(sessionFile: string): Promise<string> {
  const inspection = await SessionStore.inspect(sessionFile);
  return JSON.stringify(await inspection.getEntries());
}

function sessionFileLineCount(sessionFile: string): number {
  return readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean).length;
}

async function seedManagedSession(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  text: string,
): Promise<string> {
  createManagedSessionFileAtPath(sessionFile);
  const sessionManager = await SessionStore.open(sessionFile);
  await sessionManager.appendMessage(makeUserMessage(text));
  await sessionManager.appendMessage(makeAssistantMessage(`${text} reply`));
  return sessionFile;
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

describe("getThreadSessionFile", () => {
  test("maps thread session key to a fixed jsonl file", () => {
    expect(getThreadSessionFile(office.sessionsDir, "C123:1000.0001")).toBe(
      join(office.sessionsDir, "1000.0001.jsonl"),
    );
  });

  test.each(["C123:../other", "C123:foo/bar", String.raw`C123:foo\bar`, "C123:bad\u0000id"])(
    "rejects path-dangerous thread session key %j",
    (sessionKey) => {
      expect(() => getThreadSessionFile(office.sessionsDir, sessionKey)).toThrow();
    },
  );
});

describe("tryResolveCurrentSession", () => {
  test("ignores a current pointer that escapes the session directory", () => {
    const sessionDir = office.sessionsDir;
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(channelDir, "outside.jsonl");
    createManagedSessionFileAtPath(outside);
    writeFileSync(join(sessionDir, "current"), "../outside.jsonl");

    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
  });

  test("ignores a current pointer whose target is a symlink", () => {
    const sessionDir = office.sessionsDir;
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(channelDir, "outside.jsonl");
    createManagedSessionFileAtPath(outside);
    symlinkSync(outside, join(sessionDir, "linked.jsonl"));
    writeFileSync(join(sessionDir, "current"), "linked.jsonl");

    expect(tryResolveCurrentSession(sessionDir)).toBeNull();
  });
});

describe("tryResolveThreadSession", () => {
  test("returns null when no thread session file exists", () => {
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("ignores empty placeholder files without a valid header", () => {
    const sessionDir = office.sessionsDir;
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(threadFile, "", "utf-8");
    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("rejects a thread file symlink that targets another directory", () => {
    const sessionDir = office.sessionsDir;
    mkdirSync(sessionDir, { recursive: true });
    const outside = join(channelDir, "outside-thread.jsonl");
    createManagedSessionFileAtPath(outside);
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    symlinkSync(outside, threadFile);

    expect(tryResolveThreadSession(threadFile)).toBeNull();
  });

  test("returns fixed thread file path when a valid session exists", async () => {
    const sessionDir = office.sessionsDir;
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    const created = await seedManagedSession(threadFile, sessionDir, channelDir, "thread msg");
    expect(tryResolveThreadSession(threadFile)).toBe(created);
    expect(await sessionText(created)).toContain("thread msg");
  });
});

describe("tryResolveCurrentSession", () => {
  test("returns null when no channel session exists", () => {
    expect(tryResolveCurrentSession(office.sessionsDir)).toBeNull();
  });

  test("returns current channel session file when it exists", () => {
    const sessionDir = office.sessionsDir;
    const created = createManagedSessionFile(sessionDir);
    expect(tryResolveCurrentSession(office.sessionsDir)).toBe(created);
  });
});

describe("managed session initialization", () => {
  test("channel session filename uses a short UUID suffix", () => {
    const sessionDir = office.sessionsDir;
    const sessionFile = createManagedSessionFile(sessionDir);
    const filename = sessionFile.split("/").pop()!;
    const suffix = filename.replace(".jsonl", "").split("_").pop()!;

    expect(suffix).toMatch(/^[0-9a-f]{8}$/);
  });

  test("a channel session keeps a one-line header after messages", async () => {
    const sessionDir = office.sessionsDir;
    const sessionFile = resolveManagedSessionFile(sessionDir);
    const sessionManager = await SessionStore.open(sessionFile);

    await sessionManager.appendMessage(makeUserMessage("hello"));
    await sessionManager.appendMessage(makeAssistantMessage("hi"));

    expect(SessionStore.readHeader(sessionFile)).not.toBeNull();
    expect(sessionFileLineCount(sessionFile)).toBe(1);
  });

  test("opens a missing managed session file and writes its header on first append", async () => {
    const sessionDir = office.sessionsDir;
    const sessionFile = join(sessionDir, "missing.jsonl");
    const sessionManager = await SessionStore.open(sessionFile);

    await sessionManager.appendMessage(makeUserMessage("hello"));
    await sessionManager.appendMessage(makeAssistantMessage("hi"));

    expect(SessionStore.readHeader(sessionFile)).not.toBeNull();
    expect(sessionFileLineCount(sessionFile)).toBe(1);
  });

  test("a fixed-path thread session keeps a one-line header after messages", async () => {
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile);
    const sessionManager = await SessionStore.open(threadFile);

    await sessionManager.appendMessage(makeUserMessage("hello thread"));
    await sessionManager.appendMessage(makeAssistantMessage("thread reply"));

    expect(SessionStore.readHeader(threadFile)).not.toBeNull();
    expect(sessionFileLineCount(threadFile)).toBe(1);
  });
});

describe("fixed thread sessions", () => {
  test("thread session has a different session ID than channel session", async () => {
    const sessionDir = office.sessionsDir;
    const channelFile = resolveManagedSessionFile(sessionDir);
    const channelSM = await SessionStore.open(channelFile);
    await channelSM.appendMessage(makeUserMessage("hello channel"));
    await channelSM.appendMessage(makeAssistantMessage("hi there"));
    const channelSessionId = channelSM.getSessionId();

    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile);
    const threadSM = await SessionStore.open(threadFile);
    await threadSM.appendMessage(makeUserMessage("hello thread"));
    await threadSM.appendMessage(makeAssistantMessage("thread reply"));

    expect(threadSM.getSessionId()).not.toBe(channelSessionId);
    expect(await sessionText(threadFile)).not.toContain("hello channel");
  });

  test("second thread access reuses the same fixed thread file", async () => {
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile);
    const threadSM = await SessionStore.open(threadFile);
    const threadSessionId = threadSM.getSessionId();

    await threadSM.appendMessage(makeUserMessage("thread msg"));
    await threadSM.appendMessage(makeAssistantMessage("thread reply"));
    await threadSM.close();

    const existing = tryResolveThreadSession(threadFile);
    expect(existing).toBe(threadFile);

    const reopened = await SessionStore.open(existing!);
    expect(reopened.getSessionId()).toBe(threadSessionId);
    expect(await sessionText(existing!)).toContain("thread msg");
  });

  test("different threads get independent session IDs", async () => {
    const sessionDir = office.sessionsDir;
    const channelFile = resolveManagedSessionFile(sessionDir);
    const channelSM = await SessionStore.open(channelFile);

    const thread1File = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(office.sessionsDir, "C123:1000.0002");
    createManagedSessionFileAtPath(thread1File);
    createManagedSessionFileAtPath(thread2File);

    const thread1SM = await SessionStore.open(thread1File);
    const thread2SM = await SessionStore.open(thread2File);

    const ids = new Set([
      channelSM.getSessionId(),
      thread1SM.getSessionId(),
      thread2SM.getSessionId(),
    ]);
    expect(ids.size).toBe(3);
  });

  test("fresh thread file can be created without a channel source", async () => {
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    createManagedSessionFileAtPath(threadFile);
    const threadSM = await SessionStore.open(threadFile);
    const entries = (await threadSM.getEntries()).filter((e) => e.type === "message");
    expect(entries.length).toBe(0);
  });
});

describe("long-lived session scopes", () => {
  test("scope resolution reuses an old top-level session", async () => {
    const sessionDir = office.sessionsDir;
    const currentFile = createManagedSessionFile(sessionDir);
    rewriteSessionTimestamp(currentFile, "2026-01-05T12:00:00.000Z");

    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const scope = await manager.resolveSessionScope({
      office,
      sessionKey: "C123",
    });

    expect(scope.contextFile).toBe(currentFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(currentFile);
  });

  test("scope resolution reuses stale thread sessions", async () => {
    const sessionDir = office.sessionsDir;
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    await seedManagedSession(threadFile, sessionDir, channelDir, "thread context");
    rewriteSessionTimestamp(threadFile, "2026-01-05T12:00:00.000Z");

    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const scope = await manager.resolveSessionScope({
      office,
      sessionKey: "C123:1000.0001",
    });

    expect(scope.contextFile).toBe(threadFile);
    expect(await sessionText(threadFile)).toContain("thread context");
  });

  test("keeps old top-level context out of thread sessions after bootstrap", async () => {
    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-03-01T12:00:00.000Z"),
    });
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
      office,
      sessionKey: "C123:1771545600.000000",
    });
    const reused = await manager.resolveSessionScope({
      office,
      sessionKey: "C123:1771545600.000000",
    });

    expect(reused.contextFile).toBe(created.contextFile);
    const content = await sessionText(reused.contextFile);
    expect(content).toContain("thread root");
    expect(content).toContain("thread reply");
    expect(content).not.toContain("old top-level context");
  });

  test("keeps old log messages out after a reset", async () => {
    const sessionDir = office.sessionsDir;
    const oldFile = createManagedSessionFile(sessionDir);
    rewriteSessionTimestamp(oldFile, "2026-01-05T12:00:00.000Z");
    appendLogMessage({
      ts: "1770163200.000000",
      date: "2026-02-04T00:00:00.000Z",
      text: "old log only",
    });

    const manager = new ChatHistorySync({
      isCommandText,
      now: () => new Date("2026-03-01T12:00:00.000Z"),
    });
    const resetFile = await manager.resetSession({
      office,
      sessionKey: "C123",
    });
    const reused = await manager.resolveSessionScope({
      office,
      sessionKey: "C123",
    });

    expect(reused.contextFile).toBe(resetFile);
    expect(await sessionText(reused.contextFile)).not.toContain("old log only");
    const entries = await (await SessionStore.inspect(reused.contextFile)).getEntries();
    expect(
      entries.some((entry) => entry.type === "custom" && entry.customType === "mikan.chat_sync"),
    ).toBe(true);
  });
});

describe("session-scoped /new reset", () => {
  test("channel /new rotates channel current pointer and keeps thread session intact", async () => {
    const sessionDir = office.sessionsDir;
    const channelFile = createManagedSessionFile(sessionDir);
    const originalChannel = await SessionStore.open(channelFile);
    await originalChannel.appendMessage(makeUserMessage("channel"));
    await originalChannel.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    await seedManagedSession(threadFile, sessionDir, channelDir, "thread");

    const newChannelFile = createManagedSessionFile(sessionDir);

    expect(newChannelFile).not.toBe(channelFile);
    expect(tryResolveCurrentSession(sessionDir)).toBe(newChannelFile);
    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(await sessionText(threadFile)).toContain("thread");
  });

  test("thread /new recovers a corrupt fixed-path session while preserving the raw file", async () => {
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    mkdirSync(office.sessionsDir, { recursive: true });
    writeFileSync(threadFile, "not a session\n");

    const sync = new ChatHistorySync({ isCommandText });
    await sync.resetSession({
      office,
      sessionKey: "C123:1000.0001",
    });

    expect(SessionStore.readHeader(threadFile)?.id).toBeDefined();
    const corruptArchive = readdirSync(office.sessionsDir).find((name) =>
      name.endsWith(".jsonl.corrupt"),
    );
    expect(corruptArchive).toBeDefined();
    expect(readFileSync(join(office.sessionsDir, corruptArchive!), "utf-8")).toBe(
      "not a session\n",
    );
  });

  test("thread /new archives old evidence and keeps channel plus sibling thread intact", async () => {
    const sessionDir = office.sessionsDir;
    const channelFile = createManagedSessionFile(sessionDir);
    const channelSM = await SessionStore.open(channelFile);
    await channelSM.appendMessage(makeUserMessage("channel"));
    await channelSM.appendMessage(makeAssistantMessage("channel reply"));
    const channelId = SessionStore.readHeader(channelFile)!.id;

    const thread1File = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    const thread2File = getThreadSessionFile(office.sessionsDir, "C123:1000.0002");
    await seedManagedSession(thread1File, sessionDir, channelDir, "thread1");
    await seedManagedSession(thread2File, sessionDir, channelDir, "thread2");
    const oldThreadId = SessionStore.readHeader(thread1File)!.id;

    const sync = new ChatHistorySync({ isCommandText });
    await sync.resetSession({
      office,
      sessionKey: "C123:1000.0001",
    });

    const archive = readdirSync(sessionDir).find(
      (name) => name.includes(oldThreadId.slice(0, 8)) && name.endsWith(".jsonl"),
    );
    expect(archive).toBeDefined();
    expect(await sessionText(join(sessionDir, archive!))).toContain("thread1");
    expect(tryResolveThreadSession(thread1File)).toBe(thread1File);
    expect(await sessionText(thread1File)).not.toContain("thread1");
    expect(await sessionText(thread2File)).toContain("thread2");
    expect(await sessionText(resolveManagedSessionFile(sessionDir))).toContain("channel");
    expect(sessionFileLineCount(thread1File)).toBe(1);

    const laterThreadKey = `C123:${(Date.now() / 1000 + 60).toFixed(4)}`;
    const later = await sync.resolveSessionScope({
      office,
      sessionKey: laterThreadKey,
    });
    expect(SessionStore.readHeader(later.contextFile)?.parentSessionId).toBe(channelId);
  });
});

describe("persistence across restart", () => {
  test("thread session survives simulated restart via fixed file path", async () => {
    const sessionDir = office.sessionsDir;
    const threadFile = getThreadSessionFile(office.sessionsDir, "C123:1000.0001");
    await seedManagedSession(threadFile, sessionDir, channelDir, "thread specific");

    expect(tryResolveThreadSession(threadFile)).toBe(threadFile);
    expect(await sessionText(threadFile)).toContain("thread specific");
  });
});
