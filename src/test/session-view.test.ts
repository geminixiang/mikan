import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office, Workspace } from "../office/types.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionStore } from "../sessions/session-store.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getThreadSessionFile,
} from "../sessions/store.js";
import {
  handleSessionViewRequest,
  InMemorySessionViewTokenStore,
  parseUserBody,
} from "../adapters/web/session-view/portal.js";
import { commandForms, matchCommand } from "../adapters/commands/manifest.js";
import {
  loadSessionViewModel,
  resolveExistingSessionFile,
} from "../adapters/web/session-view/portal.js";

let workspaceDir: string;
let workspace: Workspace;
let office: Office;
let conversationDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  workspaceDir = join(
    tmpdir(),
    `session-view-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  workspace = createWorkspace({ root: workspaceDir, stateDir: join(workspaceDir, "state") });
  office = workspace.office(createOfficeAddress("slack", "D123"));
  conversationDir = office.dir;
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
    const sessionDir = office.sessionsDir;
    const sessionFile = createManagedSessionFile(sessionDir);

    expect(resolveExistingSessionFile(office, "D123")).toBe(sessionFile);
  });

  test("resolves a fixed-path thread session of the same office", () => {
    const shared = workspace.office(createOfficeAddress("slack", "C123"));
    const sessionFile = getThreadSessionFile(shared.sessionsDir, "C123:1000.0001");
    createManagedSessionFileAtPath(sessionFile);

    expect(resolveExistingSessionFile(shared, "C123:1000.0001")).toBe(sessionFile);
  });
});

async function requestSessionPage(
  tokenStore: InMemorySessionViewTokenStore,
  token: string,
  sessionFile: string,
): Promise<number> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await handleSessionViewRequest(req, res, url, tokenStore);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const params = new URLSearchParams({ token, session: basename(sessionFile) });
    return (await fetch(`http://127.0.0.1:${address.port}/session?${params}`)).status;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("session view selection", () => {
  test("can select the active session without claiming its writer lease", async () => {
    const sessionDir = office.sessionsDir;
    const sessionFile = createManagedSessionFile(sessionDir);
    const activeSession = await SessionStore.open(sessionFile);
    await activeSession.appendMessage(makeUserMessage("active"));
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = tokenStore.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D123",
      sessionKey: "D123",
      sessionFile,
    });

    try {
      expect(await requestSessionPage(tokenStore, token.token, sessionFile)).toBe(200);
    } finally {
      await activeSession.close();
    }
  });

  test("can select the same historical session repeatedly without leaking a writer lease", async () => {
    const sessionDir = office.sessionsDir;
    const currentFile = createManagedSessionFile(sessionDir);
    const historicalFile = createManagedSessionFile(sessionDir);
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = tokenStore.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D123",
      sessionKey: "D123",
      sessionFile: currentFile,
    });

    expect(await requestSessionPage(tokenStore, token.token, historicalFile)).toBe(200);
    expect(await requestSessionPage(tokenStore, token.token, historicalFile)).toBe(200);
  });

  test("rejects a selected session with an invalid header", async () => {
    const sessionDir = office.sessionsDir;
    const currentFile = createManagedSessionFile(sessionDir);
    const invalidFile = join(sessionDir, "invalid.jsonl");
    writeFileSync(invalidFile, "not json\n");
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = tokenStore.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D123",
      sessionKey: "D123",
      sessionFile: currentFile,
    });

    expect(await requestSessionPage(tokenStore, token.token, invalidFile)).toBe(500);
  });
});

describe("loadSessionViewModel", () => {
  test("maps session entries into a readable timeline", async () => {
    const sessionDir = office.sessionsDir;
    const sessionFile = createManagedSessionFile(sessionDir);
    const sessionManager = await SessionStore.open(sessionFile);

    await sessionManager.appendMessage(makeUserMessage("請幫我看一下測試結果"));
    await sessionManager.appendMessage(makeAssistantMessage("好的，我正在查看。"));

    const model = await loadSessionViewModel(sessionFile);

    expect(model.title).toContain("Session");
    expect(model.items.map((item) => item.title)).toEqual(["User", "Assistant"]);
    expect(model.items[0]?.body).toContain("請幫我看一下測試結果");
    expect(model.items[1]?.body).toContain("好的，我正在查看");
    expect(model.threads).toEqual([]);
  });

  test("preserves assistant content block order", async () => {
    const sessionDir = office.sessionsDir;
    const sessionFile = createManagedSessionFile(sessionDir);
    const sessionManager = await SessionStore.open(sessionFile);

    await sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "toolCall", id: "call-1", name: "search", arguments: { q: "raw" } },
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
    });

    const model = await loadSessionViewModel(sessionFile);

    expect(model.items[0]?.body).toBe('before\n\n[toolCall] search\n{\n  "q": "raw"\n}\n\nafter');
  });

  test("keeps channel and thread sessions on separate pages while linking them", async () => {
    const sessionDir = office.sessionsDir;
    const channelFile = createManagedSessionFile(sessionDir);
    const channelSession = await SessionStore.open(channelFile);
    await channelSession.appendMessage({
      ...makeUserMessage("channel root"),
      timestamp: Number("1000.0001") * 1000,
    });
    await channelSession.appendMessage(makeAssistantMessage("channel reply"));

    const threadFile = getThreadSessionFile(office.sessionsDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile);
    const threadSession = await SessionStore.open(threadFile);
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
    const sessionDir = office.sessionsDir;
    const channelFile = createManagedSessionFile(sessionDir);
    const channelSession = await SessionStore.open(channelFile);
    await channelSession.appendMessage({ ...makeUserMessage("prior context"), timestamp: 1 });
    await channelSession.appendMessage(makeAssistantMessage("prior reply"));
    await channelSession.appendMessage({ ...makeUserMessage("thread root"), timestamp: 2 });
    await channelSession.appendMessage(makeAssistantMessage("channel reply after root"));

    const threadFile = getThreadSessionFile(office.sessionsDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile);
    const threadSession = await SessionStore.open(threadFile);
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
    const sessionDir = office.sessionsDir;
    const channelFile = createManagedSessionFile(sessionDir);
    const channelSession = await SessionStore.open(channelFile);
    await channelSession.appendMessage(
      makeUserMessage(
        "[2026-04-28 18:18:59+08:00] [alice]: first\n\n<slack_attachments>\n/tmp/a.txt\n</slack_attachments>",
      ),
    );
    await channelSession.appendMessage(makeAssistantMessage("first reply"));

    const threadFile = getThreadSessionFile(office.sessionsDir, "D123:M1");
    createManagedSessionFileAtPath(threadFile);
    const threadSession = await SessionStore.open(threadFile);
    await threadSession.appendMessage(makeUserMessage("[alice]: first"));
    await threadSession.appendMessage(makeAssistantMessage("thread reply"));

    const channelModel = await loadSessionViewModel(channelFile);
    const userAnchor = channelModel.items.find((item) => item.body?.includes("first"));

    expect(channelModel.threads).toHaveLength(1);
    expect(userAnchor?.threads?.[0]?.fileName).toBe(basename(threadFile));
  });
});

describe("session lineage", () => {
  test("resolves a parent session id only inside the thread's own sessions directory", async () => {
    const elsewhere = join(workspaceDir, "elsewhere");
    const outsideFile = createManagedSessionFile(elsewhere);
    const threadFile = getThreadSessionFile(office.sessionsDir, "D123:1000.0001");
    createManagedSessionFileAtPath(threadFile, SessionStore.readHeader(outsideFile)!.id);

    const model = await loadSessionViewModel(threadFile);

    expect(model.parent?.fileName).not.toBe(basename(outsideFile));
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
