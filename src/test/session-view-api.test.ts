import { officeSessionsDir } from "../office/index.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createManagedSessionFile, openManagedSession } from "../sessions/store.js";
import { InMemorySessionViewTokenStore } from "../web/session-view/store.js";
import { handleSessionViewApiRequest } from "../web/session-view/api.js";
import type { SessionViewApiResponse } from "@geminixiang/mikan-daemon-web-bridge";

let workspaceDir: string;
let conversationDir: string;
let nextTimestamp = 1;

beforeEach(() => {
  nextTimestamp = 1;
  workspaceDir = join(
    tmpdir(),
    `session-view-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

interface Captured {
  status: number;
  body: unknown;
}

function capture(): { res: ServerResponse; get: () => Captured } {
  let status = 200;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(text?: string) {
      if (text !== undefined) body = String(text);
      return res;
    },
    write() {
      return true;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get: () => ({ status, body: JSON.parse(body || "null") as unknown }),
  };
}

function request(url: string, method = "GET"): { req: IncomingMessage; url: URL } {
  return { req: { url, method } as IncomingMessage, url: new URL(`http://localhost${url}`) };
}

describe("GET /api/session/view", () => {
  test("returns the session model for a valid token", () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const sessionManager = openManagedSession(sessionFile, conversationDir);
    sessionManager.appendMessage(makeUserMessage("請幫我看一下測試結果"));
    sessionManager.appendMessage(makeAssistantMessage("好的，我正在查看。"));

    const tokenStore = new InMemorySessionViewTokenStore();
    const token = tokenStore.create("slack", "U123", "D123", "D123", sessionFile);

    const { req, url } = request(`/api/session/view?token=${token.token}`);
    const { res, get } = capture();
    const handled = handleSessionViewApiRequest(req, res, url, tokenStore);

    expect(handled).toBe(true);
    const captured = get();
    expect(captured.status).toBe(200);
    const payload = captured.body as SessionViewApiResponse;
    expect(payload.model.items.map((item) => item.title)).toEqual(["User", "Assistant"]);
    expect(payload.model.items[0]?.body).toContain("請幫我看一下測試結果");
    expect(payload.displayedSessionKey).toBe("D123");
    expect(payload.isRunning).toBe(false);
  });

  test("rejects a missing or expired token with 400", () => {
    const tokenStore = new InMemorySessionViewTokenStore();
    const { req, url } = request("/api/session/view?token=nope");
    const { res, get } = capture();
    const handled = handleSessionViewApiRequest(req, res, url, tokenStore);
    expect(handled).toBe(true);
    expect(get().status).toBe(400);
  });

  test("declines non-matching paths", () => {
    const tokenStore = new InMemorySessionViewTokenStore();
    const { req, url } = request("/api/other");
    const { res } = capture();
    expect(handleSessionViewApiRequest(req, res, url, tokenStore)).toBe(false);
  });

  test("rejects a sibling session file outside the sessions dir", () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const sessionFile = createManagedSessionFile(sessionDir, conversationDir);
    const tokenStore = new InMemorySessionViewTokenStore();
    const token = tokenStore.create("slack", "U123", "D123", "D123", sessionFile);

    const { req, url } = request(
      `/api/session/view?token=${token.token}&session=${encodeURIComponent("../evil.jsonl")}`,
    );
    const { res, get } = capture();
    const handled = handleSessionViewApiRequest(req, res, url, tokenStore);
    expect(handled).toBe(true);
    expect(get().status).toBe(400);
  });
});
