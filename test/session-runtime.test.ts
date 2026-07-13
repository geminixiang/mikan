import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  ConversationResponder,
  MessagingInfo,
} from "../src/adapter.js";
import { MikanModels } from "../src/harness/index.js";
import { registerThreadSession } from "../src/sessions/agent-memory-file-manager.js";
import { createConversationRuntime } from "../src/runtime/conversation-runtime.js";
import {
  createManagedSessionFile,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
} from "../src/sessions/store.js";
import type { SandboxConfig } from "../src/sandbox/index.js";

let workingDir: string;
let conversationDir: string;

beforeEach(() => {
  workingDir = join(
    tmpdir(),
    `mikan-session-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  conversationDir = join(workingDir, "C123");
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

function makeRuntime(models?: MikanModels) {
  const sandbox: SandboxConfig = { type: "host" };
  return createConversationRuntime({ workingDir, sandbox, models });
}

function createFauxModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
  const stateDir = join(workingDir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
  );
  process.env.MIKAN_STATE_DIR = stateDir;

  const authPath = join(stateDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
  const models = MikanModels.create({
    authPath,
    modelsJsonPath: join(stateDir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

function makeResponder(): ConversationResponder {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
    replaceResponse: vi.fn().mockResolvedValue(undefined),
    respondDiagnostic: vi.fn().mockResolvedValue(undefined),
    respondToolResult: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    setWorking: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteResponse: vi.fn().mockResolvedValue(undefined),
  };
}

const testPlatform: MessagingInfo = {
  name: "chat",
  formattingGuide: "",
  channels: [],
  users: [],
  trustModel: "membership",
};

function makeEventAndContext(ts: string): {
  event: ConversationEvent;
  context: ConversationContext;
} {
  const event: ConversationEvent = {
    type: "message",
    conversationId: "C123",
    conversationKind: "shared",
    ts,
    user: "U1",
    text: `message ${ts}`,
    sessionKey: "C123",
  };
  return {
    event,
    context: {
      message: {
        id: ts,
        sessionKey: "C123",
        conversationKind: "shared",
        userId: "U1",
        userName: "alice",
        text: event.text,
        attachments: [],
      },
      responder: makeResponder(),
      platform: testPlatform,
    },
  };
}

const bot = {
  postMessage: vi.fn().mockResolvedValue("TS"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
} as unknown as MessagingBot;

describe("ConversationRuntime handleEvent", () => {
  test("two events on one session key run serially, not concurrently", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);

    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    faux.setResponses([
      async () => {
        order.push("run1:start");
        await firstGate;
        order.push("run1:end");
        return fauxAssistantMessage("first");
      },
      () => {
        order.push("run2:start");
        return fauxAssistantMessage("second");
      },
    ]);

    const first = makeEventAndContext("1000.1");
    const second = makeEventAndContext("1000.2");

    const firstDone = runtime.handleEvent(first.event, bot, first.context);
    await vi.waitFor(() => expect(order).toContain("run1:start"));
    expect(runtime.isRunning("C123")).toBe(true);
    expect(runtime.getRunningSessions().map((session) => session.sessionKey)).toEqual(["C123"]);

    const secondDone = runtime.handleEvent(second.event, bot, second.context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain("run2:start");

    releaseFirst();
    await Promise.all([firstDone, secondDone]);

    expect(order).toEqual(["run1:start", "run1:end", "run2:start"]);
    expect(runtime.isRunning("C123")).toBe(false);
    expect(first.context.responder.replaceResponse).toHaveBeenCalledWith(
      expect.stringContaining("first"),
      expect.anything(),
    );
    expect(second.context.responder.replaceResponse).toHaveBeenCalledWith(
      expect.stringContaining("second"),
      expect.anything(),
    );
  });
});

function makeUserMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as const;
}

describe("ConversationRuntime chat session scope", () => {
  test("uses a pre-registered empty thread session for Slack event anchors", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = openManagedSession(channelFile, conversationDir);
    channelSession.appendMessage(makeUserMessage("channel history should not leak"));

    const runtime = makeRuntime();
    registerThreadSession({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    // This intentionally reaches the session manager directly: the bug was in
    // pre-run session materialization, before a public run can observe it.
    const sessionScope = await (runtime as any).chatSessionManager.resolveSessionScope({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    expect(sessionScope.contextFile).toBe(getThreadSessionFile(conversationDir, "C123:2000.0001"));
    expect(sessionScope.threadRootMessage).toBeNull();
    expect(readFileSync(sessionScope.contextFile, "utf-8")).not.toContain(
      "channel history should not leak",
    );
  });
});
