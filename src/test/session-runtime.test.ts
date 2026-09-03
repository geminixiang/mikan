import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createOfficeAddress, createWorkspace, officeSessionsDir } from "../office/index.js";
import { createGlobalSettingsFile } from "../config.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  ConversationResponder,
  MessagingInfo,
} from "../adapter.js";
import { MikanModels, SessionStore } from "../harness/index.js";
import { ChatHistorySync, registerThreadSession } from "../sessions/chat-history-sync.js";
import {
  createManagedSessionFile,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
} from "../sessions/store.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import type { SessionLifecycle } from "../runtime/session-lifecycle.js";
import type { ConversationRuntimeState } from "../runtime/types.js";
import type { PiAgentWrapper } from "../types.js";
import type { SandboxConfig } from "../sandbox/index.js";

const testAddress = createOfficeAddress("slack", "C123");

let workingDir: string;
let conversationDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  workingDir = join(
    tmpdir(),
    `mikan-session-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Every runtime path reads global settings and the office registry; a
  // test-scoped state dir keeps that off the developer's real ~/.mikan.
  const stateDir = join(workingDir, "state");
  mkdirSync(stateDir, { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  createGlobalSettingsFile(stateDir);
  conversationDir = createWorkspace({ root: workingDir, stateDir }).office(testAddress).ensure();
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

function makeRuntime(models?: MikanModels) {
  const sandbox: SandboxConfig = { type: "host" };
  const workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  return createConversationRuntime({ workspace, sandbox, models });
}

function createFauxModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
  const stateDir = join(workingDir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
  process.env.MIKAN_STATE_DIR = stateDir;

  const models = MikanModels.create({
    modelsJsonPath: join(stateDir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

function rewriteSessionTimestamp(sessionFile: string, timestamp: string): void {
  const lines = readFileSync(sessionFile, "utf-8").split("\n");
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  header.timestamp = timestamp;
  header.createdAt = new Date(timestamp).getTime();
  lines[0] = JSON.stringify(header);
  writeFileSync(sessionFile, lines.join("\n"));
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
  name: "slack",
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
    address: testAddress,
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
      address: testAddress,
      message: {
        address: testAddress,
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
  getMessagingInfo: vi.fn().mockReturnValue(testPlatform),
} as unknown as MessagingBot;

/**
 * Seed a live shared-session state whose runner is entirely stubbed, so a test
 * can assert on the dispatch gate without standing up a model.
 */
function seedRunnerState(runtime: ConversationRuntime): PiAgentWrapper {
  const runner = {
    run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
    syncChatHistory: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    getCurrentStep: vi.fn(),
  } as unknown as PiAgentWrapper;
  const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
  sessions.set({
    address: testAddress,
    sessionKey: "C123",
    running: false,
    runner,
    stopRequested: false,
    lastAccessedAt: Date.now(),
    sessionFile: createManagedSessionFile(officeSessionsDir(conversationDir), conversationDir),
    startedAt: 0,
  });
  return runner;
}

function newCommandOptions(responder = makeResponder()) {
  return {
    sessionKey: "C123",
    conversationId: "C123",
    bot,
    message: {
      address: testAddress,
      id: "memory:C123",
      sessionKey: "C123",
      conversationKind: "direct" as const,
      userId: "U1",
      userName: "alice",
      text: "/new",
    },
    responder,
    platform: testPlatform,
  };
}

describe("ConversationRuntime handleEvent", () => {
  test("single-flights concurrent runner creation for one runtime key", async () => {
    const { models } = createFauxModels();
    writeFileSync(
      join(conversationDir, "log.jsonl"),
      `${JSON.stringify({ date: new Date().toISOString(), ts: "1", user: "U2", text: "seed" })}\n`,
    );
    const runtime = makeRuntime(models);
    const internal = runtime as unknown as {
      acquireState(options: {
        address: typeof testAddress;
        conversationId: string;
        sessionKey: string;
        conversationKind: "shared";
        trustModel: "membership" | "open-trigger";
      }): Promise<{ state: ConversationRuntimeState; release: () => void }>;
      createCurrentRunner: (...args: unknown[]) => Promise<PiAgentWrapper>;
    };
    const originalCreate = internal.createCurrentRunner.bind(internal);
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseCreate = resolve));
    const create = vi.spyOn(internal, "createCurrentRunner").mockImplementation(async (...args) => {
      await gate;
      return originalCreate(...args);
    });
    const options = {
      address: testAddress,
      conversationId: "C123",
      sessionKey: "C123",
      conversationKind: "shared" as const,
      trustModel: "open-trigger" as const,
    };

    const first = internal.acquireState(options);
    const second = internal.acquireState(options);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    releaseCreate();
    const [left, right] = await Promise.all([first, second]);

    expect(left.state).toBe(right.state);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ trustModel: "open-trigger" }),
      expect.anything(),
    );
    left.release();
    right.release();
    await runtime.shutdown();
  });

  test("normalizes omitted platform trust before runner materialization", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("ok")]);
    const runtime = makeRuntime(models);
    const internal = runtime as unknown as {
      createCurrentRunner: (...args: unknown[]) => Promise<PiAgentWrapper>;
    };
    const create = vi.spyOn(internal, "createCurrentRunner");
    const { event, context } = makeEventAndContext("1000.01");
    const platformWithoutTrust = { ...context.platform };
    delete platformWithoutTrust.trustModel;
    context.platform = platformWithoutTrust;

    await runtime.handleEvent(event, bot, context);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ trustModel: "membership" }),
      expect.anything(),
    );
    await runtime.shutdown();
  });

  test("uses runtime models for the default /model command handler", async () => {
    const stateDir = join(workingDir, "state");
    mkdirSync(stateDir, { recursive: true });
    const modelsJsonPath = join(stateDir, "models.json");
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "custom-provider": {
            api: "openai-completions",
            apiKey: "test-key",
            models: [{ id: "custom-model" }],
          },
        },
      }),
    );
    process.env.MIKAN_STATE_DIR = stateDir;
    const models = MikanModels.create({
      modelsJsonPath,
    });
    const runtime = makeRuntime(models);
    const { event, context } = makeEventAndContext("1000.0");
    event.text = "/model custom-provider/custom-model";
    context.message.text = event.text;

    await runtime.handleEvent(event, bot, context);

    expect(context.responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("Switched: `custom-provider/custom-model`"),
      { style: "muted" },
    );
  });

  test("waits for chat history persistence before the agent run", async () => {
    const runtime = makeRuntime();
    const runner = seedRunnerState(runtime);
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    vi.mocked(runner.syncChatHistory).mockReturnValue(syncGate);
    const order: string[] = [];
    vi.mocked(runner.syncChatHistory).mockImplementation(async () => {
      order.push("sync:start");
      await syncGate;
      order.push("sync:end");
    });
    vi.mocked(runner.run).mockImplementation(async () => {
      order.push("run");
      return { stopReason: "stop" };
    });
    const { event, context } = makeEventAndContext("1000.05");

    const done = runtime.handleEvent(event, bot, context);
    await vi.waitFor(() => expect(order).toEqual(["sync:start"]));
    expect(runner.run).not.toHaveBeenCalled();

    releaseSync();
    await done;
    expect(order).toEqual(["sync:start", "sync:end", "run"]);
  });

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
    expect(runtime.isRunning(testAddress, "C123")).toBe(true);
    expect(runtime.getRunningSessions().map((session) => session.sessionKey)).toEqual(["C123"]);

    const secondDone = runtime.handleEvent(second.event, bot, second.context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain("run2:start");

    releaseFirst();
    await Promise.all([firstDone, secondDone]);

    expect(order).toEqual(["run1:start", "run1:end", "run2:start"]);
    expect(runtime.isRunning(testAddress, "C123")).toBe(false);
    expect(first.context.responder.replaceResponse).toHaveBeenCalledWith(
      expect.stringContaining("first"),
      expect.anything(),
    );
    expect(second.context.responder.replaceResponse).toHaveBeenCalledWith(
      expect.stringContaining("second"),
      expect.anything(),
    );
  });

  test("reuses the cached session writer across incremental history sync", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
    const runtime = makeRuntime(models);
    const logPath = join(conversationDir, "log.jsonl");
    writeFileSync(
      logPath,
      `${JSON.stringify({ date: new Date().toISOString(), ts: "1", user: "U2", text: "before first turn" })}\n`,
    );

    const first = makeEventAndContext("2");
    await runtime.handleEvent(first.event, bot, first.context);
    const sessionFile = resolveChannelSessionFile(conversationDir)!;

    writeFileSync(
      logPath,
      [
        JSON.stringify({
          date: new Date().toISOString(),
          ts: "3",
          user: "U2",
          text: "between turns",
        }),
        JSON.stringify({
          date: new Date().toISOString(),
          ts: "4",
          user: "U1",
          text: "message 4",
        }),
      ].join("\n") + "\n",
      { flag: "a" },
    );
    const second = makeEventAndContext("4");
    await runtime.handleEvent(second.event, bot, second.context);

    const reopened = await SessionStore.inspect(sessionFile);
    const entries = await reopened.getEntries();
    const serialized = JSON.stringify(entries);
    expect(serialized.match(/between turns/g)).toHaveLength(1);
    expect(serialized).toContain("second reply");
  });
});

describe("ConversationRuntime lifecycle", () => {
  test("global refresh defers invalidation until the busy conversation settles", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([
      async () => {
        started = true;
        await gate;
        return fauxAssistantMessage("first");
      },
      fauxAssistantMessage("second"),
    ]);

    const first = makeEventAndContext("1000.0");
    const firstDone = runtime.handleEvent(first.event, bot, first.context);
    await vi.waitFor(() => expect(started).toBe(true));

    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    const oldState = sessions.get(testAddress, "C123");
    expect(oldState).toBeDefined();
    const oldRunner = oldState!.runner;
    const dispose = vi.spyOn(oldRunner, "dispose");

    expect(runtime.refreshAllConversations()).toEqual({ busy: [testAddress] });
    expect(runtime.refreshAllConversations()).toEqual({ busy: [testAddress] });
    expect(dispose).not.toHaveBeenCalled();

    release();
    await firstDone;
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.get(testAddress, "C123")).toBeUndefined();

    const second = makeEventAndContext("1000.1");
    await runtime.handleEvent(second.event, bot, second.context);

    const newState = sessions.get(testAddress, "C123");
    expect(newState).toBeDefined();
    expect(newState!.runner).not.toBe(oldRunner);
  });

  test("new dispatched inside the session queue does not deadlock", async () => {
    const { models } = createFauxModels();
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
      conversationDir,
    );
    const { event, context } = makeEventAndContext("1000.25");
    event.conversationKind = "direct";
    event.text = "/new";
    context.message.conversationKind = "direct";
    context.message.text = "/new";

    await runtime.handleEvent(event, bot, context);

    await vi.waitFor(() => {
      expect(bot.postMessage).toHaveBeenCalledWith(
        "C123",
        "Conversation reset. Send a new message to start fresh.",
      );
    });
    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
  });

  test("new waits for the active run settlement before resetting and disposing", async () => {
    const runtime = makeRuntime();
    const sessionDir = officeSessionsDir(conversationDir);
    const originalSession = createManagedSessionFile(sessionDir, conversationDir);
    let settle!: () => void;
    const runSettlement = new Promise<void>((resolve) => (settle = resolve));
    const runner = {
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      syncChatHistory: vi.fn(),
    } as unknown as PiAgentWrapper;
    const state: ConversationRuntimeState = {
      address: testAddress,
      sessionKey: "C123",
      running: true,
      runSettlement,
      runner,
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: originalSession,
      startedAt: Date.now(),
    };
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    sessions.set(state);

    const reset = runtime.handleNewCommand(newCommandOptions());
    await vi.waitFor(() => expect(runner.abort).toHaveBeenCalledOnce());

    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);
    expect(runner.dispose).not.toHaveBeenCalled();
    expect(bot.postMessage).not.toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );

    state.running = false;
    settle();
    await reset;

    await vi.waitFor(() => {
      expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    });
    expect(runner.dispose).toHaveBeenCalledOnce();
    expect(bot.postMessage).toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );
  });

  test("force stop keeps a session running until its run settles", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([
      async () => {
        started = true;
        await gate;
        return fauxAssistantMessage("stopped");
      },
    ]);
    const { event, context } = makeEventAndContext("1000.3");
    const run = runtime.handleEvent(event, bot, context);
    await vi.waitFor(() => expect(started).toBe(true));

    runtime.forceStop(testAddress, "C123");
    expect(runtime.isRunning(testAddress, "C123")).toBe(true);

    release();
    await run;
    expect(runtime.isRunning(testAddress, "C123")).toBe(false);
  });

  test("new creates a clean session immediately without changing memory", async () => {
    const runtime = makeRuntime();
    const runner = seedRunnerState(runtime);
    const originalSession = resolveChannelSessionFile(conversationDir)!;
    const memoryPath = join(conversationDir, "MEMORY.md");
    writeFileSync(memoryPath, "stable anchor\n");

    await runtime.handleNewCommand(newCommandOptions());

    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    expect(readFileSync(memoryPath, "utf-8")).toBe("stable anchor\n");
    expect(runner.dispose).toHaveBeenCalledOnce();
    expect(bot.postMessage).toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );
  });

  test("new can reset an unmaterialized session without creating a runner", async () => {
    const runtime = makeRuntime();

    await runtime.handleNewCommand(newCommandOptions());

    expect(resolveChannelSessionFile(conversationDir)).not.toBeNull();
    expect(runtime.getRunningSessions()).toEqual([]);
  });

  test("automatic biweekly rotation creates a clean session", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("new session reply")]);
    const runtime = makeRuntime(models);
    const runner = seedRunnerState(runtime);
    const originalSession = resolveChannelSessionFile(conversationDir)!;
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");

    const { event, context } = makeEventAndContext("3");
    await runtime.handleEvent(event, bot, context);
    await vi.waitFor(() =>
      expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession),
    );
    await vi.waitFor(() => expect(runner.dispose).toHaveBeenCalledOnce());
    expect(runner.syncChatHistory).not.toHaveBeenCalled();

    await vi.waitFor(() =>
      expect(context.responder.replaceResponse).toHaveBeenCalledWith(
        expect.stringContaining("new session reply"),
        expect.anything(),
      ),
    );
  });

  test("reset boundary survives recreation without disabling later incremental sync", async () => {
    writeFileSync(
      join(conversationDir, "log.jsonl"),
      [
        JSON.stringify({ date: new Date().toISOString(), ts: "1", user: "U1", text: "old" }),
        JSON.stringify({
          date: new Date().toISOString(),
          ts: "2",
          text: "old reply",
          isMessagingBot: true,
        }),
      ].join("\n") + "\n",
    );
    const sync = new ChatHistorySync();
    await sync.resetSession({ conversationDir, sessionKey: "C123" });

    // Scope resolution only materializes; run the runtime's incremental
    // sync explicitly, as ConversationRuntime does per event.
    const syncOnce = async (file: string) => {
      const session = await openManagedSession(file, conversationDir);
      try {
        await sync.syncSessionManager({
          conversationDir,
          sessionKey: "C123",
          sessionManager: session,
        });
      } finally {
        await session.close();
      }
    };

    const freshFile = resolveChannelSessionFile(conversationDir);
    await syncOnce(freshFile);
    expect(readFileSync(freshFile, "utf-8")).not.toContain('"text":"old"');

    writeFileSync(
      join(conversationDir, "log.jsonl"),
      JSON.stringify({ date: new Date().toISOString(), ts: "3", user: "U1", text: "new" }) + "\n",
      { flag: "a" },
    );
    await syncOnce(freshFile);
    expect(readFileSync(freshFile, "utf-8")).toContain("new");
  });

  test("new resets an idle session immediately", async () => {
    const { models } = createFauxModels();
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
      conversationDir,
    );

    await runtime.handleNewCommand(newCommandOptions());

    await vi.waitFor(() => {
      expect(bot.postMessage).toHaveBeenCalledWith(
        "C123",
        "Conversation reset. Send a new message to start fresh.",
      );
    });
    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
  });
});

describe("ChatHistorySync session scope", () => {
  test("uses a pre-registered empty thread session for event anchors", async () => {
    const sessionDir = officeSessionsDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = await openManagedSession(channelFile, conversationDir);
    await channelSession.appendMessage({
      role: "user",
      content: [{ type: "text", text: "channel history should not leak" }],
      timestamp: 1,
    });
    await channelSession.close();
    registerThreadSession({
      conversationDir,
      sessionKey: "C123:2000.0001",
      cwd: conversationDir,
    });

    const sessionScope = await new ChatHistorySync().resolveSessionScope({
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
