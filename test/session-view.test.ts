import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
} from "../packages/mikan/src/sessions/store.js";
import { parseUserBody } from "../packages/mikan/src/web/session-view/portal.js";
import { parseSessionViewCommand } from "../packages/mikan/src/web/session-view/command.js";
import {
  loadSessionViewModel,
  resolveExistingSessionFile,
} from "../packages/mikan/src/web/session-view/service.js";

let workspaceDir: string;
let conversationDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  workspaceDir = join(
    tmpdir(),
    `session-view-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  conversationDir = join(workspaceDir, "D123");
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
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

describe("parseSessionViewCommand", () => {
  test("recognizes supported commands", () => {
    expect(parseSessionViewCommand("session")).toEqual({ command: "session" });
    expect(parseSessionViewCommand("/session")).toEqual({ command: "/session" });
    expect(parseSessionViewCommand("/pi-session now")).toEqual({ command: "/pi-session" });
  });

  test("ignores unrelated text", () => {
    expect(parseSessionViewCommand("hello there")).toBeNull();
  });
});

describe("resolveExistingSessionFile", () => {
  test("resolves the current channel session", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);

    expect(resolveExistingSessionFile(workspaceDir, "D123", "D123")).toBe(sessionFile);
  });

  test("resolves a fixed-path thread session when the conversation directory matches", () => {
    const sharedConversationDir = join(workspaceDir, "C123");
    mkdirSync(sharedConversationDir, { recursive: true });
    const sessionFile = getThreadSessionFile(sharedConversationDir, "C123:1000.0001");
    createManagedSessionFileAtPath(sessionFile, sharedConversationDir);

    expect(resolveExistingSessionFile(workspaceDir, "C123", "C123:1000.0001")).toBe(sessionFile);
  });
});

describe("loadSessionViewModel", () => {
  test("maps session entries into a readable timeline", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);

    sessionManager.appendMessage(makeUserMessage("請幫我看一下測試結果"));
    sessionManager.appendMessage(makeAssistantMessage("好的，我正在查看。"));
    sessionManager.appendMessage({
      role: "bashExecution",
      command: "npm test",
      output: "1 passed",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: nextTimestamp++,
    } as any);

    const model = loadSessionViewModel(sessionFile);

    expect(model.title).toContain("Session");
    expect(model.items.map((item) => item.title)).toEqual(["User", "Assistant", "Bash execution"]);
    expect(model.items[0].body).toContain("請幫我看一下測試結果");
    expect(model.items[1].body).toContain("好的，我正在查看");
    expect(model.items[2].body).toContain("npm test");
    expect(model.items[2].body).toContain("1 passed");
    expect(model.threads).toEqual([]);
  });

  test("preserves assistant content block order and bash execution status details", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const sessionManager = openManagedSession(sessionFile, sessionDir, conversationDir);

    sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "toolCall", name: "search", arguments: { q: "raw" } },
        { type: "text", text: "after" },
      ],
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
    } as any);
    sessionManager.appendMessage({
      role: "bashExecution",
      command: "npm test",
      output: "1 failed",
      exitCode: 1,
      cancelled: true,
      truncated: true,
      timestamp: nextTimestamp++,
    } as any);

    const model = loadSessionViewModel(sessionFile);

    expect(model.items[0]?.body).toBe('before\n\n[toolCall] search\n{\n  "q": "raw"\n}\n\nafter');
    expect(model.items[1]?.body).toContain("[exitCode] 1");
    expect(model.items[1]?.body).toContain("[cancelled] true");
    expect(model.items[1]?.body).toContain("[truncated] true");
  });

  test("keeps channel and thread sessions on separate pages while linking them", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSession.appendMessage({
      ...makeUserMessage("channel root"),
      timestamp: Number("1000.0001") * 1000,
    });
    channelSession.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(conversationDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile, conversationDir);
    const threadSession = openManagedSession(threadFile, sessionDir, conversationDir);
    threadSession.appendMessage({
      ...makeUserMessage("channel root"),
      timestamp: Number("1000.0001") * 1000,
    });
    threadSession.appendMessage(makeUserMessage("thread only"));
    threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = loadSessionViewModel(channelFile);
    expect(channelModel.items.some((item) => item.body?.includes("thread only"))).toBe(false);
    expect(channelModel.threads).toHaveLength(1);
    expect(channelModel.threads[0]?.fileName).toBe(basename(threadFile));
    const rootItem = channelModel.items.find((item) => item.body?.includes("channel root"));
    expect(rootItem?.threads?.[0]?.fileName).toBe(basename(threadFile));

    const threadModel = loadSessionViewModel(threadFile);
    expect(threadModel.parent?.fileName).toBe(basename(channelFile));
    expect(threadModel.items.some((item) => item.body?.includes("thread only"))).toBe(true);
  });

  test("anchors fixed thread links to the root instead of earlier bootstrap context", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSession.appendMessage({ ...makeUserMessage("prior context"), timestamp: 1 });
    channelSession.appendMessage(makeAssistantMessage("prior reply"));
    channelSession.appendMessage({ ...makeUserMessage("thread root"), timestamp: 2 });
    channelSession.appendMessage(makeAssistantMessage("channel reply after root"));

    const threadFile = getThreadSessionFile(conversationDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile, conversationDir);
    const threadSession = openManagedSession(threadFile, sessionDir, conversationDir);
    threadSession.appendMessage({ ...makeUserMessage("prior context"), timestamp: 1 });
    threadSession.appendMessage(makeAssistantMessage("prior reply"));
    threadSession.appendMessage({ ...makeUserMessage("thread root"), timestamp: 2 });
    threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = loadSessionViewModel(channelFile);
    const contextItem = channelModel.items.find((item) => item.body?.includes("prior context"));
    const rootItem = channelModel.items.find((item) => item.body?.includes("thread root"));

    expect(contextItem?.threads).toBeUndefined();
    expect(rootItem?.threads?.[0]?.fileName).toBe(basename(threadFile));
  });

  test("anchors non-timestamp thread files by matching the root message", () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = openManagedSession(channelFile, sessionDir, conversationDir);
    channelSession.appendMessage(
      makeUserMessage(
        "[2026-04-28 18:18:59+08:00] [alice]: first\n\n<slack_attachments>\n/tmp/a.txt\n</slack_attachments>",
      ),
    );
    channelSession.appendMessage(makeAssistantMessage("first reply"));

    const threadFile = getThreadSessionFile(conversationDir, "D123:M1");
    createManagedSessionFileAtPath(threadFile, conversationDir);
    const threadSession = openManagedSession(threadFile, sessionDir, conversationDir);
    threadSession.appendMessage(makeUserMessage("[alice]: first"));
    threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = loadSessionViewModel(channelFile);
    const userAnchor = channelModel.items.find((item) => item.body?.includes("first"));

    expect(channelModel.threads).toHaveLength(1);
    expect(userAnchor?.threads?.[0]?.fileName).toBe(basename(threadFile));
  });
});

describe("parseUserBody", () => {
  test("strips in-thread markers from timestamped user messages", () => {
    expect(
      parseUserBody(
        "[2026-04-29 00:11:10+08:00] [geminixiang] [in-thread:1777386320.800769]: hello from thread",
      ),
    ).toEqual({
      timestamp: "2026-04-29 00:11:10+08:00",
      username: "geminixiang",
      threadTs: "1777386320.800769",
      header: "[2026-04-29 00:11:10+08:00] [geminixiang] [in-thread:1777386320.800769]",
      content: "hello from thread",
    });
  });

  test("parses thread markers from non-timestamped user messages", () => {
    expect(parseUserBody("[alice] [in-thread:M1]: discord thread reply")).toEqual({
      timestamp: null,
      username: "alice",
      threadTs: "M1",
      header: "[alice] [in-thread:M1]",
      content: "discord thread reply",
    });
  });

  test("returns null threadTs for top-level user messages", () => {
    expect(parseUserBody("[alice]: top level")).toEqual({
      timestamp: null,
      username: "alice",
      threadTs: null,
      header: "[alice]",
      content: "top level",
    });
  });
});
