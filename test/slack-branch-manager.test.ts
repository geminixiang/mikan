import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  registerSlackForkSession,
  resolveSlackSessionScope,
  waitForSlackBranchBootstrap,
} from "../src/adapters/slack/branch-manager.js";
import { getChannelSessionDir, getThreadSessionFile } from "../src/sessions/store.js";

let conversationDir: string;

beforeEach(() => {
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

describe("waitForSlackBranchBootstrap", () => {
  test("waits for the parent session to finish before first thread bootstrap", async () => {
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
  test("uses generic log-based top-level session bootstrap", async () => {
    const recentDate = new Date().toISOString();
    writeLog([
      {
        date: recentDate,
        ts: "1000.0001",
        user: "U123",
        userName: "alice",
        text: "prior top-level",
        isBot: false,
      },
      {
        date: recentDate,
        ts: "1000.0002",
        user: "U123",
        userName: "alice",
        text: "current top-level",
        isBot: false,
      },
    ]);

    const { sessionDir, contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123",
      cwd: conversationDir,
      currentMessageId: "1000.0002",
    });

    expect(sessionDir).toBe(getChannelSessionDir(conversationDir));
    expect(threadRootMessage).toBeNull();
    const text = readContextText(contextFile);
    expect(text).toContain("prior top-level");
    expect(text).not.toContain("current top-level");
  });

  test("uses generic log-based thread bootstrap instead of forking top-level sessions", async () => {
    const recentDate = new Date().toISOString();
    writeLog([
      {
        date: recentDate,
        ts: "1000.0001",
        user: "U123",
        userName: "alice",
        text: "recent top-level context",
        isBot: false,
      },
      {
        date: recentDate,
        ts: "2000.0001",
        user: "U456",
        userName: "bob",
        text: "thread root",
        isBot: false,
      },
      {
        date: recentDate,
        ts: "2000.0002",
        threadTs: "2000.0001",
        user: "bot",
        text: "thread reply",
        isBot: true,
      },
      {
        date: recentDate,
        ts: "2000.0003",
        threadTs: "2000.0001",
        user: "U456",
        userName: "bob",
        text: "current thread message",
        isBot: false,
      },
    ]);

    const { contextFile, threadRootMessage } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
      currentMessageId: "2000.0003",
    });

    expect(contextFile).toBe(getThreadSessionFile(conversationDir, "C123:2000.0001"));
    expect(threadRootMessage?.text).toBe("thread root");
    const text = readContextText(contextFile);
    expect(text).toContain("recent top-level context");
    expect(text).toContain("thread root");
    expect(text).toContain("thread reply");
    expect(text).not.toContain("current thread message");
  });

  test("pre-registered Slack event anchor sessions do not bootstrap channel history", async () => {
    writeLog([
      {
        date: new Date().toISOString(),
        ts: "1000.0001",
        user: "U123",
        userName: "alice",
        text: "channel history should not leak",
        isBot: false,
      },
    ]);

    registerSlackForkSession({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    const { contextFile } = await resolveSlackSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    const text = readContextText(contextFile);
    expect(text).not.toContain("channel history should not leak");
  });
});
