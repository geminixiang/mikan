import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
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
import type { AgentAuditEventInput, AgentAuditRun, AgentAuditService } from "../audit/index.js";
import { MikanModels, SessionStore } from "../harness/index.js";
import { AgentRunSetupError } from "../agent/runner.js";
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
import { shouldRotateTopLevelSession } from "../sessions/store.js";

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

function makeRuntime(models?: MikanModels, audit?: AgentAuditService) {
  const sandbox: SandboxConfig = { type: "host" };
  const workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  return createConversationRuntime({ workspace, sandbox, models, audit });
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

async function appendSessionMessage(
  sessionFile: string,
  cwd: string,
  message: Parameters<SessionStore["appendMessage"]>[0],
): Promise<void> {
  const store = await SessionStore.open(sessionFile, cwd);
  try {
    await store.appendMessage(message);
  } finally {
    await store.close();
  }
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

class CapturedAuditRun implements AgentAuditRun {
  readonly runId: string;
  readonly runKind: AgentAuditRun["runKind"];
  readonly parentRunId?: string;
  readonly events: AgentAuditEventInput[] = [];
  readonly children: CapturedAuditRun[] = [];

  constructor(runId: string, runKind: AgentAuditRun["runKind"], parentRunId?: string) {
    this.runId = runId;
    this.runKind = runKind;
    this.parentRunId = parentRunId;
  }

  record(event: AgentAuditEventInput): void {
    this.events.push(event);
  }

  child(options: { runKind: AgentAuditRun["runKind"]; runId?: string }): AgentAuditRun {
    const child = new CapturedAuditRun(
      options.runId ?? `child-${this.children.length + 1}`,
      options.runKind,
      this.runId,
    );
    this.children.push(child);
    return child;
  }
}

class CapturedAuditService implements AgentAuditService {
  readonly runs: CapturedAuditRun[] = [];

  startRun(identity: { runKind: AgentAuditRun["runKind"]; runId?: string }): AgentAuditRun {
    const run = new CapturedAuditRun(
      identity.runId ?? `run-${this.runs.length + 1}`,
      identity.runKind,
    );
    this.runs.push(run);
    return run;
  }

  async listRuns(): Promise<never> {
    throw new Error("not used");
  }
  async getRun(): Promise<never> {
    throw new Error("not used");
  }
  async getHealth(): Promise<never> {
    throw new Error("not used");
  }
  async flush(): Promise<void> {}
  async runRetention(): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {}
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
function seedRunnerState(
  runtime: ConversationRuntime,
  tryExtensionCommand: ReturnType<typeof vi.fn>,
): PiAgentWrapper {
  const runner = {
    dreamSessionMemory: vi.fn().mockResolvedValue({ stopReason: "stop" }),
    run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
    syncChatHistory: vi.fn(),
    tryExtensionCommand,
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
  test("single-flights concurrent runner creation for one runtime key", async () => {
    const { models } = createFauxModels();
    writeFileSync(
      join(conversationDir, "log.jsonl"),
      `${JSON.stringify({ date: new Date().toISOString(), ts: "1", user: "U2", text: "seed" })}\n`,
    );
    const runtime = makeRuntime(models);
    const internal = runtime as unknown as {
      getOrCreateState(options: {
        address: typeof testAddress;
        conversationId: string;
        sessionKey: string;
        conversationKind: "shared";
      }): Promise<ConversationRuntimeState>;
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
    };

    const first = internal.getOrCreateState(options);
    const second = internal.getOrCreateState(options);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    releaseCreate();
    const [left, right] = await Promise.all([first, second]);

    expect(left).toBe(right);
    expect(create).toHaveBeenCalledOnce();
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

  test("waits for chat history persistence before extension dispatch and agent run", async () => {
    const runtime = makeRuntime();
    const tryExtensionCommand = vi.fn().mockResolvedValue(false);
    const runner = seedRunnerState(runtime, tryExtensionCommand);
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
    vi.mocked(runner.tryExtensionCommand).mockImplementation(async () => {
      order.push("extension");
      return false;
    });
    vi.mocked(runner.run).mockImplementation(async () => {
      order.push("run");
      return { stopReason: "stop" };
    });
    const { event, context } = makeEventAndContext("1000.05");

    const done = runtime.handleEvent(event, bot, context);
    await vi.waitFor(() => expect(order).toEqual(["sync:start"]));
    expect(runner.tryExtensionCommand).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();

    releaseSync();
    await done;
    expect(order).toEqual(["sync:start", "sync:end", "run"]);
  });

  test("allocates one runtime audit run and settles it with normalized metrics", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("audited")]);
    const audit = new CapturedAuditService();
    const runtime = makeRuntime(models, audit);
    const { event, context } = makeEventAndContext("1000.08");

    await runtime.handleEvent(event, bot, context);

    expect(audit.runs).toHaveLength(1);
    expect(audit.runs[0]).toMatchObject({ runKind: "interactive" });
    expect(audit.runs[0]?.events.map((item) => item.type)).toEqual([
      "run_admitted",
      "run_started",
      "turn_started",
      "model_request_started",
      "model_request_completed",
      "turn_completed",
      "run_completed",
    ]);
    expect(audit.runs[0]?.events.at(-1)).toMatchObject({
      status: "completed",
      llmCalls: 1,
      toolCalls: 0,
      usage: expect.objectContaining({ totalTokens: expect.any(Number) }),
    });
    expect(JSON.stringify(audit.runs)).not.toContain(event.text);

    await runtime.shutdown();
  });

  test("records setup failure as the run's only terminal audit event", async () => {
    const audit = new CapturedAuditService();
    const runtime = makeRuntime(undefined, audit);
    const runner = seedRunnerState(runtime, vi.fn().mockResolvedValue(false));
    vi.mocked(runner.run).mockRejectedValue(new AgentRunSetupError(new Error("setup failed")));
    const { event, context } = makeEventAndContext("1000.09");

    await runtime.handleEvent(event, bot, context);

    const terminal = audit.runs[0]?.events.filter((item) =>
      ["run_setup_failed", "run_completed", "run_failed", "run_aborted"].includes(item.type),
    );
    expect(terminal).toEqual([
      expect.objectContaining({ type: "run_setup_failed", status: "failed" }),
    ]);
    await runtime.shutdown();
  });

  test("does not rewrite an agent outcome when stop notification delivery fails", async () => {
    const audit = new CapturedAuditService();
    const runtime = makeRuntime(undefined, audit);
    const runner = seedRunnerState(runtime, vi.fn().mockResolvedValue(false));
    const sessions = (runtime as unknown as { sessions: SessionLifecycle }).sessions;
    vi.mocked(runner.run).mockImplementation(async () => {
      const state = sessions.get(testAddress, "C123")!;
      state.stopRequested = true;
      return { stopReason: "aborted" };
    });
    const failingBot = {
      ...bot,
      postMessage: vi.fn().mockRejectedValue(new Error("delivery failed")),
    } as unknown as MessagingBot;
    const { event, context } = makeEventAndContext("1000.095");

    await expect(runtime.handleEvent(event, failingBot, context)).rejects.toThrow(
      "delivery failed",
    );

    const terminal = audit.runs[0]?.events.filter((item) =>
      ["run_setup_failed", "run_completed", "run_failed", "run_aborted"].includes(item.type),
    );
    expect(terminal).toEqual([expect.objectContaining({ type: "run_aborted", status: "aborted" })]);
    await runtime.shutdown();
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

  test("a platform that eats the slash dispatches extension commands bare", async () => {
    const runtime = makeRuntime();
    const tryExtensionCommand = vi.fn().mockResolvedValue(true);
    seedRunnerState(runtime, tryExtensionCommand);

    const { event, context } = makeEventAndContext("1100.1");
    event.text = "pm status";
    context.message.text = event.text;
    context.platform = { ...testPlatform, bareExtensionCommands: true };

    await runtime.handleEvent(event, bot, context);

    expect(tryExtensionCommand).toHaveBeenCalledWith(context.message, context.responder, {
      bareName: true,
    });
  });

  test("without the capability, unslashed text never reaches extension dispatch", async () => {
    const runtime = makeRuntime();
    const tryExtensionCommand = vi.fn().mockResolvedValue(false);
    seedRunnerState(runtime, tryExtensionCommand);

    const { event, context } = makeEventAndContext("1100.2");
    event.text = "pm status";
    context.message.text = event.text;
    context.platform = { ...testPlatform, bareExtensionCommands: undefined };

    await runtime.handleEvent(event, bot, context);

    expect(tryExtensionCommand).not.toHaveBeenCalled();
  });

  test("a slash command still dispatches with bare matching off", async () => {
    const runtime = makeRuntime();
    const tryExtensionCommand = vi.fn().mockResolvedValue(true);
    seedRunnerState(runtime, tryExtensionCommand);

    const { event, context } = makeEventAndContext("1100.3");
    event.text = "/pm status";
    context.message.text = event.text;
    context.platform = { ...testPlatform, bareExtensionCommands: undefined };

    await runtime.handleEvent(event, bot, context);

    expect(tryExtensionCommand).toHaveBeenCalledWith(context.message, context.responder, {
      bareName: false,
    });
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
      dreamSessionMemory: vi.fn().mockResolvedValue({ stopReason: "stop" }),
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

  test("normal work waits for direct session Dream and its reset boundary", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("after reset")]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
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
      syncChatHistory: vi.fn(),
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
    await maintenance;
    expect(runtime.isRunning(testAddress, "C123")).toBe(true);
    expect(runtime.getRunningSessions()).toEqual([expect.objectContaining({ sessionKey: "C123" })]);

    const { event, context } = makeEventAndContext("2");
    const normalWork = runtime.handleEvent(event, bot, context);
    await Promise.resolve();
    expect(runner.run).not.toHaveBeenCalled();
    expect(runner.dispose).not.toHaveBeenCalled();

    releaseMaintenance();
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
      officeSessionsDir(conversationDir),
      conversationDir,
    );
    await appendSessionMessage(originalSession, conversationDir, {
      role: "user",
      content: [{ type: "text", text: "old shared decision" }],
      timestamp: 1,
    });
    rewriteSessionTimestamp(originalSession, "2026-01-05T12:00:00.000Z");

    expect(shouldRotateTopLevelSession(originalSession, new Date())).toBe(true);

    const { event, context } = makeEventAndContext("3");
    await runtime.handleEvent(event, bot, context);

    await vi.waitFor(() => expect(readFileSync(memoryPath, "utf-8")).toBe("shared decision"));
    await vi.waitFor(() =>
      expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession),
    );
    expect(context.responder.respondDiagnostic).not.toHaveBeenCalled();
    expect(readFileSync(resolveChannelSessionFile(conversationDir), "utf-8")).not.toContain(
      "old shared decision",
    );
  });

  test("automatic shared rotation runs Dream in the background", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
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
    await topLevelDone;

    const thread = makeThreadEventAndContext("2000.2");
    const threadDone = runtime.handleEvent(thread.event, bot, thread.context);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(runStarts).toEqual([]);
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);

    releaseDream();
    await threadDone;

    expect(runStarts).toContain("thread");
    expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
  });

  test("automatic shared rotation defers refresh until Dream settles", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
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
      officeSessionsDir(conversationDir),
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

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce());
    expect(runner.dreamSessionMemory).toHaveBeenCalledOnce();
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);
  });

  test("keeps the old shared session when session Dream runs out of budget", async () => {
    // A budget abort stops with "aborted", not "error". Treated as success it
    // resets the session and silently discards the memory the dream existed to
    // write, so anything short of a clean stop has to block the rotation.
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
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

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce());
    expect(runner.dreamSessionMemory).toHaveBeenCalledOnce();
    expect(resolveChannelSessionFile(conversationDir)).toBe(originalSession);
  });

  test("maintenance failure clears active state and keeps the runner reusable", async () => {
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
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
    await vi.waitFor(() => expect(runtime.isRunning(testAddress, "C123")).toBe(false));

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
      officeSessionsDir(conversationDir),
      conversationDir,
    );
    await appendSessionMessage(originalSession, conversationDir, {
      role: "user",
      content: [{ type: "text", text: "old durable decision" }],
      timestamp: 1,
    });

    await runtime.handleNewCommand(...newCommandArgs());

    await vi.waitFor(() => {
      expect(readFileSync(memoryPath, "utf-8")).toBe("durable decision");
      expect(runtime.isRunning(testAddress, "C123")).toBe(false);
      expect(resolveChannelSessionFile(conversationDir)).not.toBe(originalSession);
    });
    const freshSession = resolveChannelSessionFile(conversationDir);
    expect(freshSession).not.toBe(originalSession);
    expect(readFileSync(freshSession, "utf-8")).not.toContain("old durable decision");
  });

  test("memory failure leaves the current session intact", async () => {
    const runtime = makeRuntime();
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
      conversationDir,
    );
    const responder = makeResponder();
    const runner = {
      dreamSessionMemory: vi.fn().mockResolvedValue({
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
      syncChatHistory: vi.fn(),
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

    await vi.waitFor(() => expect(runtime.isRunning(testAddress, "C123")).toBe(false));
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
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("memory preserved")]);
    const runtime = makeRuntime(models);
    const originalSession = createManagedSessionFile(
      officeSessionsDir(conversationDir),
      conversationDir,
    );

    await runtime.handleNewCommand(...newCommandArgs());

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
