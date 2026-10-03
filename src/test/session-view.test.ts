import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office, Workspace } from "../office/types.js";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionStore } from "../sessions/session-store.js";
import {
  handleSessionViewRequest,
  InMemorySessionViewTokenStore,
  parseUserBody,
} from "../adapters/web/session-view/portal.js";
import { commandForms, matchCommand } from "../adapters/commands/manifest.js";
import { loadSessionViewModel } from "../adapters/web/session-view/portal.js";

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

async function requestSessionPage(
  tokenStore: InMemorySessionViewTokenStore,
  token: string,
  sessionKey: string,
): Promise<number> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await handleSessionViewRequest(req, res, url, tokenStore);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const params = new URLSearchParams({ token, session: sessionKey });
    return (await fetch(`http://127.0.0.1:${address.port}/session?${params}`)).status;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function viewToken(tokenStore: InMemorySessionViewTokenStore, sessionKey = "D123") {
  return tokenStore.create({
    platform: "slack",
    platformUserId: "U1",
    conversationId: "D123",
    sessionKey,
    office,
  });
}

describe("session view selection", () => {
  test("can select the active session without claiming its writer lease", async () => {
    const activeSession = await SessionStore.open(office, "D123");
    await activeSession.appendMessage(makeUserMessage("active"));
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = viewToken(tokenStore);

    try {
      expect(await requestSessionPage(tokenStore, token.token, "D123")).toBe(200);
    } finally {
      await activeSession.close();
    }
  });

  test("can select another session of the office repeatedly", async () => {
    await (await SessionStore.open(office, "D123")).close();
    await (await SessionStore.open(office, "D123:1000.0001")).close();
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = viewToken(tokenStore);

    expect(await requestSessionPage(tokenStore, token.token, "D123:1000.0001")).toBe(200);
    expect(await requestSessionPage(tokenStore, token.token, "D123:1000.0001")).toBe(200);
  });

  test("rejects a session the office does not have", async () => {
    await (await SessionStore.open(office, "D123")).close();
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = viewToken(tokenStore);

    expect(await requestSessionPage(tokenStore, token.token, "C999:1000.0001")).toBe(400);
  });
});

describe("loadSessionViewModel", () => {
  test("maps session entries into a readable timeline", async () => {
    const sessionManager = await SessionStore.open(office, "D123");
    await sessionManager.appendMessage(makeUserMessage("請幫我看一下測試結果"));
    await sessionManager.appendMessage(makeAssistantMessage("好的，我正在查看。"));
    await sessionManager.close();

    const model = await loadSessionViewModel(office, "D123");

    expect(model.title).toContain("Session");
    expect(model.items.map((item) => item.title)).toEqual(["User", "Assistant"]);
    expect(model.items[0]?.body).toContain("請幫我看一下測試結果");
    expect(model.items[1]?.body).toContain("好的，我正在查看");
    expect(model).not.toHaveProperty("threads");
  });

  test("preserves assistant content block order", async () => {
    const sessionManager = await SessionStore.open(office, "D123");
    await sessionManager.appendMessage({
      ...makeAssistantMessage(""),
      content: [
        { type: "text", text: "before" },
        { type: "toolCall", id: "call-1", name: "search", arguments: { q: "raw" } },
        { type: "text", text: "after" },
      ],
    });
    await sessionManager.close();

    const model = await loadSessionViewModel(office, "D123");

    expect(model.items[0]?.body).toBe('before\n\n[toolCall] search\n{\n  "q": "raw"\n}\n\nafter');
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
