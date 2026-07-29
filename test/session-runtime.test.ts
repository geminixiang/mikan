import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createOfficeAddress, createWorkspace } from "../src/office/index.js";
import { createGlobalSettingsFile } from "../src/config.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  ConversationResponder,
  MessagingInfo,
} from "../src/adapter.js";
import { MikanModels } from "../src/harness/index.js";
import { ChatHistorySync, registerThreadSession } from "../src/sessions/chat-history-sync.js";
import {
  createManagedSessionFile,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
} from "../src/sessions/store.js";
import { createConversationRuntime } from "../src/runtime/conversation-runtime.js";
import { SessionLifecycle } from "../src/runtime/session-lifecycle.js";
import type { ConversationRuntimeState } from "../src/runtime/types.js";
import type { PiAgentWrapper } from "../src/types.js";
import type { SandboxConfig } from "../src/sandbox/index.js";
import { shouldRotateTopLevelSession } from "../src/sessions/rotation.js";

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

function rewriteSessionTimestamp(sessionFile: string, timestamp: string): void {
  const lines = readFileSync(sessionFile, "utf-8").split("\n");
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  header.timestamp = timestamp;
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

function makeThreadEventAndContext(ts: string): {
  event: ConversationEvent;
  context: ConversationContext;
} {
  const result = makeEventAndContext(ts);
  const threadTs = "2000.1";
  result.event.text = `thread message ${ts}`;
  result.event.thread_ts = threadTs;
  result.event.sessionKey = `C123:${threadTs}`;
  result.context.message.text = result.event.text;
  result.context.message.threadTs = threadTs;
  result.context.message.sessionKey = result.event.sessionKey;
  return result;
}

const bot = {
  postMessage: vi.fn().mockResolvedValue("TS"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  getMessagingInfo: vi.fn().mockReturnValue(testPlatform),
} as unknown as MessagingBot;

function newCommandArgs(responder = makeResponder()) {
  return [
    "C123",
    "C123",
    bot,
    {
      address: testAddress,
      id: "memory:C123",
      sessionKey: "C123",
      conversationKind: "direct" as const,
      userId: "U1",
      userName: "alice",
      text: "/new",
    },
    responder,
    testPlatform,
  ] as const;
}

describe("ConversationRuntime handleEvent", () => {
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
      authPath: join(stateDir, "auth.json"),
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
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("memory preserved")]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    const { event, context } = makeEventAndContext("1000.25");
    event.conversationKind = "direct";
    event.text = "/new";
    context.message.conversationKind = "direct";
    context.message.text = "/new";

    await runtime.handleEvent(event, bot, context);

    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    expect(bot.postMessage).toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );
  });

  test("new waits for the active run settlement before resetting and disposing", async () => {
    const runtime = makeRuntime();
    const sessionDir = getChannelSessionDir(conversationDir);
    const originalSession = createManagedSessionFile(sessionDir, conversationDir);
    let settle!: () => void;
    const runSettlement = new Promise<void>((resolve) => (settle = resolve));
    const runner = {
      abort: vi.fn(),
      dreamSessionMemory: vi.fn().mockResolvedValue({ stopReason: "stop" }),
      dispose: vi.fn().mockResolvedValue(undefined),
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

    const reset = runtime.handleNewCommand(...newCommandArgs());
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

    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
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

  test("normal work waits for direct session Dream and its reset boundary", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("after reset")]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    let releaseMaintenance!: () => void;
    const maintenanceGate = new Promise<void>((resolve) => (releaseMaintenance = resolve));
    const runner = {
      dreamSessionMemory: vi.fn(async () => {
        await maintenanceGate;
        return { stopReason: "stop" };
      }),
      run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      getCurrentStep: vi.fn(),
    } as unknown as PiAgentWrapper;
    const state: ConversationRuntimeState = {
      address: testAddress,
      sessionKey: "C123",
      running: false,
      runner,
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: originalSession,
      startedAt: 0,
    };
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    sessions.set(state);

    const maintenance = runtime.handleNewCommand(...newCommandArgs());
    await vi.waitFor(() => expect(runner.dreamSessionMemory).toHaveBeenCalledOnce());
    expect(runtime.isRunning(testAddress, "C123")).toBe(true);
    expect(runtime.getRunningSessions()).toEqual([expect.objectContaining({ sessionKey: "C123" })]);

    const { event, context } = makeEventAndContext("2");
    const normalWork = runtime.handleEvent(event, bot, context);
    await Promise.resolve();
    expect(runner.run).not.toHaveBeenCalled();
    expect(runner.dispose).not.toHaveBeenCalled();

    releaseMaintenance();
    await maintenance;
    await normalWork;

    expect(runner.run).not.toHaveBeenCalled();
    expect(runner.dispose).toHaveBeenCalledOnce();
    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    expect(runtime.isRunning(testAddress, "C123")).toBe(false);
  });

  test("preserves memory before automatic biweekly rotation", async () => {
    const { models, faux } = createFauxModels();
    const memoryPath = join(conversationDir, "MEMORY.md");
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("old shared decision");
        return fauxAssistantMessage(
          fauxToolCall("write", {
            label: "preserve memory before rotation",
            path: memoryPath,
            content: "shared decision",
          }),
        );
      },
      fauxAssistantMessage("memory preserved"),
      fauxAssistantMessage("new session reply"),
    ]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    openManagedSession(originalSession, conversationDir).appendMessage({
      role: "user",
      content: [{ type: "text", text: "old shared decision" }],
      timestamp: 1,
    });
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");

    expect(shouldRotateTopLevelSession(originalSession, new Date())).toBe(true);

    const { event, context } = makeEventAndContext("3");
    await runtime.handleEvent(event, bot, context);

    expect(context.responder.respondDiagnostic).not.toHaveBeenCalled();
    expect(readFileSync(memoryPath, "utf-8")).toBe("shared decision");
    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    expect(readFileSync(resolveChannelSessionFile(conversationDir), "utf-8")).not.toContain(
      "old shared decision",
    );
  });

  test("automatic shared rotation blocks thread startup until Dream and rotation finish", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");

    let dreamStarted = false;
    let releaseDream!: () => void;
    const dreamGate = new Promise<void>((resolve) => (releaseDream = resolve));
    const runStarts: string[] = [];
    const recordRun = (context: { messages: unknown[] }) => {
      const messages = JSON.stringify(context.messages);
      runStarts.push(messages.includes("thread message") ? "thread" : "top-level");
      expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
      return fauxAssistantMessage("reply");
    };
    faux.setResponses([
      async () => {
        dreamStarted = true;
        await dreamGate;
        return fauxAssistantMessage("memory preserved");
      },
      recordRun,
      recordRun,
    ]);

    const topLevel = makeEventAndContext("5");
    const topLevelDone = runtime.handleEvent(topLevel.event, bot, topLevel.context);
    await vi.waitFor(() => expect(dreamStarted).toBe(true));

    const thread = makeThreadEventAndContext("2000.2");
    const threadDone = runtime.handleEvent(thread.event, bot, thread.context);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runStarts).toEqual([]);
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);

    releaseDream();
    await Promise.all([topLevelDone, threadDone]);

    expect(runStarts).toContain("thread");
    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
  });

  test("automatic shared rotation defers refresh until Dream settles", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");

    let dreamStarted = false;
    let releaseDream!: () => void;
    const dreamGate = new Promise<void>((resolve) => (releaseDream = resolve));
    let runStarted = false;
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => (releaseRun = resolve));
    faux.setResponses([
      async () => {
        dreamStarted = true;
        await dreamGate;
        return fauxAssistantMessage("memory preserved");
      },
      async () => {
        runStarted = true;
        await runGate;
        return fauxAssistantMessage("reply");
      },
    ]);

    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    const { event, context } = makeEventAndContext("6");
    const done = runtime.handleEvent(event, bot, context);
    await vi.waitFor(() => expect(dreamStarted).toBe(true));

    const oldState = sessions.get(testAddress, "C123");
    expect(oldState).toBeDefined();
    const oldRunner = oldState!.runner;
    const oldDispose = vi.spyOn(oldRunner, "dispose");

    expect(runtime.refreshAllConversations()).toEqual({ busy: [testAddress] });
    expect(oldDispose).not.toHaveBeenCalled();

    releaseDream();
    await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runStarted).toBe(true));
    const newState = sessions.get(testAddress, "C123");
    expect(newState).toBeDefined();
    expect(newState!.runner).not.toBe(oldRunner);
    const newDispose = vi.spyOn(newState!.runner, "dispose");

    releaseRun();
    await done;
    expect(newDispose).not.toHaveBeenCalled();
  });

  test("keeps the old shared session when automatic session Dream fails", async () => {
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");
    const runner = {
      dreamSessionMemory: vi.fn().mockResolvedValue({
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
      run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
      syncChatHistory: vi.fn(),
      tryExtensionCommand: vi.fn().mockResolvedValue(false),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      getCurrentStep: vi.fn(),
    } as unknown as PiAgentWrapper;
    const state: ConversationRuntimeState = {
      address: testAddress,
      sessionKey: "C123",
      running: false,
      runner,
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: originalSession,
      startedAt: 0,
    };
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    sessions.set(state);

    const { event, context } = makeEventAndContext("3");
    await runtime.handleEvent(event, bot, context);

    expect(runner.dreamSessionMemory).toHaveBeenCalledOnce();
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);
    expect(runner.run).toHaveBeenCalledOnce();
  });

  test("keeps the old shared session when session Dream runs out of budget", async () => {
    // A budget abort stops with "aborted", not "error". Treated as success it
    // resets the session and silently discards the memory the dream existed to
    // write, so anything short of a clean stop has to block the rotation.
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");
    const runner = {
      dreamSessionMemory: vi.fn().mockResolvedValue({
        stopReason: "aborted",
        errorMessage: "5 LLM calls >= 5 limit",
      }),
      run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
      syncChatHistory: vi.fn(),
      tryExtensionCommand: vi.fn().mockResolvedValue(false),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      getCurrentStep: vi.fn(),
    } as unknown as PiAgentWrapper;
    const state: ConversationRuntimeState = {
      address: testAddress,
      sessionKey: "C123",
      running: false,
      runner,
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: originalSession,
      startedAt: 0,
    };
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    sessions.set(state);

    const { event, context } = makeEventAndContext("4");
    await runtime.handleEvent(event, bot, context);

    expect(runner.dreamSessionMemory).toHaveBeenCalledOnce();
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);
  });

  test("maintenance failure clears active state and keeps the runner reusable", async () => {
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    let rejectMaintenance!: (reason: Error) => void;
    const maintenanceGate = new Promise<never>((_resolve, reject) => {
      rejectMaintenance = reject;
    });
    const runner = {
      dreamSessionMemory: vi.fn(() => maintenanceGate),
      run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
      syncChatHistory: vi.fn(),
      tryExtensionCommand: vi.fn().mockResolvedValue(false),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      getCurrentStep: vi.fn(),
    } as unknown as PiAgentWrapper;
    const state: ConversationRuntimeState = {
      address: testAddress,
      sessionKey: "C123",
      running: false,
      runner,
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: originalSession,
      startedAt: 0,
    };
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    sessions.set(state);

    const maintenance = runtime.handleNewCommand(...newCommandArgs());
    await vi.waitFor(() => expect(runtime.isRunning(testAddress, "C123")).toBe(true));
    rejectMaintenance(new Error("maintenance failed"));
    await maintenance;

    expect(runtime.isRunning(testAddress, "C123")).toBe(false);
    expect(state.runSettlement).toBeUndefined();
    expect(state.startedAt).toBe(0);
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);

    const { event, context } = makeEventAndContext("3");
    await runtime.handleEvent(event, bot, context);
    expect(runner.run).toHaveBeenCalledOnce();
  });

  test("session Dream sees old history and can persist MEMORY.md before reset", async () => {
    const { models, faux } = createFauxModels();
    const memoryPath = join(conversationDir, "MEMORY.md");
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("old durable decision");
        return fauxAssistantMessage(
          fauxToolCall("write", {
            label: "preserve memory",
            path: memoryPath,
            content: "durable decision",
          }),
        );
      },
      fauxAssistantMessage("done"),
    ]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    openManagedSession(originalSession, conversationDir).appendMessage({
      role: "user",
      content: [{ type: "text", text: "old durable decision" }],
      timestamp: 1,
    });

    await runtime.handleNewCommand(...newCommandArgs());

    expect(readFileSync(memoryPath, "utf-8")).toBe("durable decision");
    const freshSession = resolveChannelSessionFile(conversationDir);
    expect(freshSession).not.toBe(originalSession);
    expect(readFileSync(freshSession, "utf-8")).not.toContain("old durable decision");
  });

  test("memory failure leaves the current session intact", async () => {
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );
    const responder = makeResponder();
    const runner = {
      dreamSessionMemory: vi.fn().mockResolvedValue({
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as PiAgentWrapper;
    const state: ConversationRuntimeState = {
      address: testAddress,
      sessionKey: "C123",
      running: false,
      runner,
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: originalSession,
      startedAt: 0,
    };
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    sessions.set(state);

    await runtime.handleNewCommand(...newCommandArgs(responder));

    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);
    expect(responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("was not reset"),
      { style: "error" },
    );
    expect(bot.postMessage).not.toHaveBeenCalled();
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
    sync.resetSession({ conversationDir, sessionKey: "C123" });

    const freshFile = resolveChannelSessionFile(conversationDir);
    await sync.resolveSessionScope({ conversationDir, sessionKey: "C123" });
    expect(readFileSync(freshFile, "utf-8")).not.toContain('"text":"old"');

    writeFileSync(
      join(conversationDir, "log.jsonl"),
      JSON.stringify({ date: new Date().toISOString(), ts: "3", user: "U1", text: "new" }) + "\n",
      { flag: "a" },
    );
    await sync.resolveSessionScope({ conversationDir, sessionKey: "C123" });
    expect(readFileSync(freshFile, "utf-8")).toContain("new");
  });

  test("new resets an idle session immediately", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("memory preserved")]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      getChannelSessionDir(conversationDir),
      conversationDir,
    );

    await runtime.handleNewCommand(...newCommandArgs());

    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    expect(bot.postMessage).toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );
  });
});

describe("ChatHistorySync session scope", () => {
  test("uses a pre-registered empty thread session for event anchors", async () => {
    const sessionDir = getChannelSessionDir(conversationDir);
    const channelFile = createManagedSessionFile(sessionDir, conversationDir);
    const channelSession = openManagedSession(channelFile, conversationDir);
    channelSession.appendMessage({
      role: "user",
      content: [{ type: "text", text: "channel history should not leak" }],
      timestamp: 1,
    });
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
