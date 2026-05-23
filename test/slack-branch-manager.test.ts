import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createManagedSessionFile,
  getChannelSessionDir,
  openManagedSession,
} from "../src/sessions/store.js";
import {
  resolveSlackSessionScope,
  waitForSlackBranchBootstrap,
} from "../src/adapters/slack/branch-manager.js";

let conversationDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  conversationDir = join(
    tmpdir(),
    `slack-branch-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function makeUserMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: nextTimestamp++,
  } as const;
}

function makeAssistantMessage(text: string) {
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
  } as const;
}

describe("waitForSlackBranchBootstrap", () => {
  test("waits for the parent Slack session to finish before first thread bootstrap", async () => {
    let checks = 0;
    const sleep = vi.fn(async () => {
      checks += 1;
    });

    const waited = await waitForSlackBranchBootstrap({
      parentSessionKey: "C123",
      sessionKey: "C123:1000.0001",
      hasThreadSession: () => false,
      isParentRunning: () => checks < 3,
      sleep,
      pollMs: 1,
    });

    expect(waited).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  test("stops waiting once the thread session already exists", async () => {
    let checks = 0;
    const sleep = vi.fn(async () => {
      checks += 1;
    });

    const waited = await waitForSlackBranchBootstrap({
      parentSessionKey: "C123",
      sessionKey: "C123:1000.0001",
      hasThreadSession: () => checks >= 1,
      isParentRunning: () => true,
      sleep,
      pollMs: 1,
    });

    expect(waited).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test("does nothing for top-level sessions", async () => {
    const sleep = vi.fn(async () => {});

    expect(
      await waitForSlackBranchBootstrap({
        parentSessionKey: "C123",
        sessionKey: "C123",
        hasThreadSession: () => false,
        isParentRunning: () => true,
        sleep,
      }),
    ).toBe(false);

    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("resolveSlackSessionScope", () => {
  test("resolves the persistent top-level session", async () => {
    const { sessionDir, contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123",
    });

    expect(sessionDir).toBe(getChannelSessionDir(conversationDir));
    expect(contextFile).toContain("/sessions/");
    expect(threadRootMessage).toBeNull();
  });

  test("forks from the top-level session when the thread root is not in the log", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSM = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSM.appendMessage(
      makeUserMessage("[2026-04-28 18:19:03+08:00] [alice]: channel context"),
    );
    channelSM.appendMessage(makeAssistantMessage("channel reply"));

    const { contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:1000.0001",
    });

    expect(threadRootMessage).toBeNull();
    const content = readFileSync(contextFile, "utf-8");
    expect(content).toContain(`"parentSession":"${channelFile}"`);
    expect(content).toContain("channel context");
    expect(content).toContain("channel reply");
  });

  test("forks from top-level session when the thread root is mama's top-level response", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSM = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSM.appendMessage(makeUserMessage("[2026-04-28 18:19:03+08:00] [alice]: question"));
    channelSM.appendMessage(makeAssistantMessage("mama top-level answer"));

    writeLog([
      {
        date: "2026-04-28T10:19:00.000Z",
        ts: "2000.0001",
        user: "bot",
        text: "mama top-level answer",
        isBot: true,
      },
    ]);

    const { contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      sleep: async () => {},
      retryCount: 1,
      retryDelayMs: 0,
    });

    expect(threadRootMessage).toBeNull();
    const content = readFileSync(contextFile, "utf-8");
    expect(content).toContain(`"parentSession":"${channelFile}"`);
    expect(content).toContain("question");
    expect(content).toContain("mama top-level answer");
  });

  test("creates a root-only branch session when the parent root turn is not materialized yet", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSM = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSM.appendMessage(makeUserMessage("[2026-04-28 18:19:03+08:00] [alice]: second"));
    channelSM.appendMessage(makeAssistantMessage("second reply"));

    writeLog([
      {
        date: "2026-04-28T10:18:59.000Z",
        ts: "1000.0001",
        user: "U123",
        userName: "alice",
        text: "first",
        isBot: false,
      },
    ]);

    const { contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:1000.0001",
      sleep: async () => {},
      retryCount: 1,
      retryDelayMs: 0,
    });

    expect(threadRootMessage?.text).toBe("first");
    const content = readFileSync(contextFile, "utf-8");
    expect(content).toContain(`"parentSession":"${channelFile}"`);
    expect(content).toContain("[alice]: first");
    expect(content).not.toContain("second reply");
  });

  test("replaces a stale current session with top-level history from log", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const staleFile = createManagedSessionFile(sessionDir, conversationDir);
    const staleSession = openManagedSession(staleFile, sessionDir, conversationDir);
    staleSession.appendMessage(makeUserMessage("[2026-03-17 10:00:00+08:00] [alice]: stale"));

    writeLog([
      {
        date: new Date().toISOString(),
        ts: "1000.0001",
        user: "U123",
        userName: "alice",
        text: "fresh top-level message",
        isBot: false,
      },
    ]);

    const { contextFile } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:1000.0001",
      sleep: async () => {},
      retryCount: 1,
      retryDelayMs: 0,
    });

    const currentPointer = join(sessionDir, "current");
    const parentFile = join(sessionDir, readFileSync(currentPointer, "utf-8").trim());
    expect(parentFile).not.toBe(staleFile);
    expect(readFileSync(parentFile, "utf-8")).toContain("fresh top-level message");
    expect(readFileSync(parentFile, "utf-8")).not.toContain("stale");
    expect(readFileSync(contextFile, "utf-8")).toContain(`"parentSession":"${parentFile}"`);
  });

  test("materializes top-level history from log when a first thread has no current session", async () => {
    writeLog([
      {
        date: new Date().toISOString(),
        ts: "1000.0001",
        user: "U123",
        userName: "alice",
        text: "Instagram Reel link",
        isBot: false,
      },
      {
        date: new Date().toISOString(),
        ts: "1000.0002",
        threadTs: "1000.0001",
        user: "U456",
        userName: "bob",
        text: "thread reply should not be in top-level history",
        isBot: false,
      },
    ]);

    const { contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:1000.0001",
      sleep: async () => {},
      retryCount: 1,
      retryDelayMs: 0,
    });

    expect(threadRootMessage?.text).toBe("Instagram Reel link");
    const currentPointer = join(getChannelSessionDir(conversationDir), "current");
    expect(existsSync(currentPointer)).toBe(true);
    const parentFile = join(
      getChannelSessionDir(conversationDir),
      readFileSync(currentPointer, "utf-8").trim(),
    );
    const parentContent = readFileSync(parentFile, "utf-8");
    expect(parentContent).toContain("platform-history");
    expect(parentContent).toContain("Instagram Reel link");
    expect(parentContent).not.toContain("thread reply should not be in top-level history");

    const threadContent = readFileSync(contextFile, "utf-8");
    expect(threadContent).toContain(`"parentSession":"${parentFile}"`);
    expect(threadContent).toContain("Instagram Reel link");
  });
});
