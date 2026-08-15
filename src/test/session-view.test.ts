import { officeSessionsDir } from "../office/index.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getThreadSessionFile,
  openManagedSession,
} from "../sessions/store.js";
import { parseUserBody } from "../web/session-view/portal.js";
import { commandForms, matchCommand } from "../commands/manifest.js";
import { loadSessionViewModel, resolveExistingSessionFile } from "../web/session-view/service.js";

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

describe("session view command grammar", () => {
  const SESSION_VIEW_COMMANDS = commandForms("session");

  test("recognizes supported commands", () => {
    expect(matchCommand("session", SESSION_VIEW_COMMANDS)?.command).toBe("session");
    expect(matchCommand("/session", SESSION_VIEW_COMMANDS)?.command).toBe("/session");
    expect(matchCommand("/pi-session now", SESSION_VIEW_COMMANDS)?.command).toBe("/pi-session");
  });

  test("ignores unrelated text", () => {
    expect(matchCommand("hello there", SESSION_VIEW_COMMANDS)).toBeNull();
  });
});

describe("resolveExistingSessionFile", () => {
  test("resolves the current channel session", () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);

    expect(resolveExistingSessionFile(join(workspaceDir, "D123"), "D123")).toBe(sessionFile);
  });

  test("resolves a fixed-path thread session when the conversation directory matches", () => {
    const sharedConversationDir = join(workspaceDir, "C123");
    mkdirSync(sharedConversationDir, { recursive: true });
    const sessionFile = getThreadSessionFile(sharedConversationDir, "C123:1000.0001");
    createManagedSessionFileAtPath(sessionFile, sharedConversationDir);

    expect(resolveExistingSessionFile(join(workspaceDir, "C123"), "C123:1000.0001")).toBe(
      sessionFile,
    );
  });
});

describe("loadSessionViewModel", () => {
  test("maps session entries into a readable timeline", async () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const sessionManager = await openManagedSession(sessionFile, conversationDir);

    await sessionManager.appendMessage(makeUserMessage("請幫我看一下測試結果"));
    await sessionManager.appendMessage(makeAssistantMessage("好的，我正在查看。"));
    await sessionManager.appendMessage({
      role: "bashExecution",
      command: "npm test",
      output: "1 passed",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: nextTimestamp++,
    } as any);

    const model = await loadSessionViewModel(sessionFile);

    expect(model.title).toContain("Session");
    expect(model.items.map((item) => item.title)).toEqual(["User", "Assistant", "Bash execution"]);
    expect(model.items[0].body).toContain("請幫我看一下測試結果");
    expect(model.items[1].body).toContain("好的，我正在查看");
    expect(model.items[2].body).toContain("npm test");
    expect(model.items[2].body).toContain("1 passed");
    expect(model.threads).toEqual([]);
  });

  test("preserves assistant content block order and bash execution status details", async () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const sessionManager = await openManagedSession(sessionFile, conversationDir);

    await sessionManager.appendMessage({
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
    await sessionManager.appendMessage({
      role: "bashExecution",
      command: "npm test",
      output: "1 failed",
      exitCode: 1,
      cancelled: true,
      truncated: true,
      timestamp: nextTimestamp++,
    } as any);

    const model = await loadSessionViewModel(sessionFile);

    expect(model.items[0]?.body).toBe('before\n\n[toolCall] search\n{\n  "q": "raw"\n}\n\nafter');
    expect(model.items[1]?.body).toContain("[exitCode] 1");
    expect(model.items[1]?.body).toContain("[cancelled] true");
    expect(model.items[1]?.body).toContain("[truncated] true");
  });

  test("keeps channel and thread sessions on separate pages while linking them", async () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = await openManagedSession(channelFile, conversationDir);
    await channelSession.appendMessage({
      ...makeUserMessage("channel root"),
      timestamp: Number("1000.0001") * 1000,
    });
    await channelSession.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(conversationDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile, conversationDir);
    const threadSession = await openManagedSession(threadFile, conversationDir);
    await threadSession.appendMessage({
      ...makeUserMessage("channel root"),
      timestamp: Number("1000.0001") * 1000,
    });
    await threadSession.appendMessage(makeUserMessage("thread only"));
    await threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = await loadSessionViewModel(channelFile);
    expect(channelModel.items.some((item) => item.body?.includes("thread only"))).toBe(false);
    expect(channelModel.threads).toHaveLength(1);
    expect(channelModel.threads[0]?.fileName).toBe(basename(threadFile));
    const rootItem = channelModel.items.find((item) => item.body?.includes("channel root"));
    expect(rootItem?.threads?.[0]?.fileName).toBe(basename(threadFile));

    const threadModel = await loadSessionViewModel(threadFile);
    expect(threadModel.parent?.fileName).toBe(basename(channelFile));
    expect(threadModel.items.some((item) => item.body?.includes("thread only"))).toBe(true);
  });

  test("anchors fixed thread links to the root instead of earlier bootstrap context", async () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = await openManagedSession(channelFile, conversationDir);
    await channelSession.appendMessage({ ...makeUserMessage("prior context"), timestamp: 1 });
    await channelSession.appendMessage(makeAssistantMessage("prior reply"));
    await channelSession.appendMessage({ ...makeUserMessage("thread root"), timestamp: 2 });
    await channelSession.appendMessage(makeAssistantMessage("channel reply after root"));

    const threadFile = getThreadSessionFile(conversationDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile, conversationDir);
    const threadSession = await openManagedSession(threadFile, conversationDir);
    await threadSession.appendMessage({ ...makeUserMessage("prior context"), timestamp: 1 });
    await threadSession.appendMessage(makeAssistantMessage("prior reply"));
    await threadSession.appendMessage({ ...makeUserMessage("thread root"), timestamp: 2 });
    await threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = await loadSessionViewModel(channelFile);
    const contextItem = channelModel.items.find((item) => item.body?.includes("prior context"));
    const rootItem = channelModel.items.find((item) => item.body?.includes("thread root"));

    expect(contextItem?.threads).toBeUndefined();
    expect(rootItem?.threads?.[0]?.fileName).toBe(basename(threadFile));
  });

  test("anchors non-timestamp thread files by matching the root message", async () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = await openManagedSession(channelFile, conversationDir);
    await channelSession.appendMessage(
      makeUserMessage(
        "[2026-04-28 18:18:59+08:00] [alice]: first\n\n<slack_attachments>\n/tmp/a.txt\n</slack_attachments>",
      ),
    );
    await channelSession.appendMessage(makeAssistantMessage("first reply"));

    const threadFile = getThreadSessionFile(conversationDir, "D123:M1");
    createManagedSessionFileAtPath(threadFile, conversationDir);
    const threadSession = await openManagedSession(threadFile, conversationDir);
    await threadSession.appendMessage(makeUserMessage("[alice]: first"));
    await threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = await loadSessionViewModel(channelFile);
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
