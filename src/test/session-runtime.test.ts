import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  ConversationResponder,
  MessagingInfo,
} from "../types.js";
import { MikanModels } from "../harness/models.js";
import { SessionStore } from "../sessions/session-store.js";
import { ChatHistorySync, registerThreadSession } from "../sessions/chat-history-sync.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import type { RunMemoryCapture } from "../memory-capture/types.js";
import { createSlackAdapters } from "../adapters/slack/context.js";
import type { SlackEvent, SlackResponderBot } from "../adapters/slack/types.js";
import { createRunner } from "../harness/runner.js";
import type { RunnerFactory } from "../runtime/types.js";
import type { PiAgentWrapper } from "../types.js";
import type { SandboxConfig } from "../sandbox/types.js";
import { isCommandText } from "../adapters/commands/manifest.js";

const testAddress = createOfficeAddress("slack", "C123");

let workingDir: string;
let office: Office;
let conversationDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  workingDir = join(
    tmpdir(),
    `mikan-session-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const stateDir = join(workingDir, "state");
  mkdirSync(stateDir, { recursive: true });
  createGlobalSettingsFile(stateDir);
  office = createWorkspace({ root: workingDir, stateDir }).office(testAddress);
  conversationDir = office.ensure();
});

afterEach(() => {
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

interface MakeRuntimeOptions {
  models?: MikanModels;
  memoryCapture?: (models: MikanModels) => RunMemoryCapture;
  runnerFactory?: RunnerFactory;
}

function makeRuntime(options: MakeRuntimeOptions = {}) {
  const sandbox: SandboxConfig = { type: "host" };
  const workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  return createConversationRuntime({ workspace, sandbox, ...options });
}

function fakeRunnerFactory(runner: PiAgentWrapper) {
  return vi.fn<RunnerFactory>(async () => runner);
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

  const models = MikanModels.create({
    modelsJsonPath: join(stateDir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

async function resetCount(key = "C123"): Promise<number> {
  const inspection = await SessionStore.inspect(office, key);
  const entries = (await inspection?.getEntries()) ?? [];
  return entries.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "mikan.chat_sync" &&
      JSON.stringify(entry.data).includes("resetAt"),
  ).length;
}

async function createSession(key = "C123"): Promise<void> {
  await (await SessionStore.open(office, key)).close();
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

const bot: MessagingBot = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  postMessage: vi.fn().mockResolvedValue("TS"),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  enqueueEvent: vi.fn().mockReturnValue(true),
  getMessagingInfo: vi.fn().mockReturnValue(testPlatform),
};

function fakeRunner(): PiAgentWrapper {
  return {
    run: vi.fn().mockResolvedValue({ stopReason: "stop" }),
    syncChatHistory: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    getCurrentStep: vi.fn(),
    compact: vi.fn().mockResolvedValue({ compacted: false }),
  };
}

function newCommandOptions() {
  return {
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
  };
}

async function sessionText(key: string): Promise<string> {
  return JSON.stringify(await (await SessionStore.inspect(office, key))?.getEntries());
}

describe("ConversationRuntime handleEvent", () => {
  test("single-flights concurrent runner creation for one runtime key", async () => {
    const runner = fakeRunner();
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseCreate = resolve));
    const create = vi.fn<RunnerFactory>(async () => {
      await gate;
      return runner;
    });
    const runtime = makeRuntime({ runnerFactory: create });
    const first = makeEventAndContext("1000.001");
    const second = makeEventAndContext("1000.002");
    first.context.platform = { ...testPlatform, trustModel: "open-trigger" };
    second.context.platform = { ...testPlatform, trustModel: "open-trigger" };

    const left = runtime.runSession({ event: first.event, bot, context: first.context });
    const right = runtime.runSession({ event: second.event, bot, context: second.context });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    releaseCreate();
    await Promise.all([left, right]);

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ trustModel: "open-trigger", signal: expect.any(AbortSignal) }),
    );
    await runtime.shutdown();
  });

  test("normalizes omitted platform trust before runner materialization", async () => {
    const create = fakeRunnerFactory(fakeRunner());
    const runtime = makeRuntime({ runnerFactory: create });
    const { event, context } = makeEventAndContext("1000.01");
    const platformWithoutTrust = { ...context.platform };
    delete platformWithoutTrust.trustModel;
    context.platform = platformWithoutTrust;

    await runtime.handleEvent(event, bot, context);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ trustModel: "membership", signal: expect.any(AbortSignal) }),
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
    const models = MikanModels.create({
      modelsJsonPath,
    });
    const runtime = makeRuntime({ models });
    const { event, context } = makeEventAndContext("1000.0");
    event.text = "/model custom-provider/custom-model";
    context.message.text = event.text;

    await runtime.handleEvent(event, bot, context);

    expect(context.responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("Switched: `custom-provider/custom-model`"),
      { style: "muted" },
    );
  });

  test("Slack status pending does not delay actual runtime runner or settlement", async () => {
    const runner = fakeRunner();
    const runtime = makeRuntime({ runnerFactory: fakeRunnerFactory(runner) });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const status = vi.fn().mockReturnValue(pending);
    const slack: SlackResponderBot & MessagingBot = {
      ...bot,
      getUser: () => undefined,
      getMessagingInfo: () => testPlatform,
      setAssistantStatus: status,
      postInThread: vi.fn(),
      postInThreadBlocks: vi.fn(),
      deleteMessage: vi.fn(),
      logBotResponse: vi.fn(),
      tryReserveStreamStart: vi.fn(),
      startMessageStream: vi.fn(),
      appendMessageStream: vi.fn(),
      stopMessageStream: vi.fn(),
      uploadFile: vi.fn(),
      addReaction: vi.fn(),
    };
    const { event } = makeEventAndContext("1000.05");
    const context = createSlackAdapters({ ...event, channel: "C123" } as SlackEvent, slack);
    const done = runtime.handleEvent(event, slack, context);
    try {
      await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1), { timeout: 200 });
      await done;
      expect(status.mock.calls.map((call) => call[2])).toEqual(["Thinking", ""]);
    } finally {
      release();
      await done;
    }
  });

  test("waits for chat history persistence before the agent run", async () => {
    const runner = fakeRunner();
    const runtime = makeRuntime({ runnerFactory: fakeRunnerFactory(runner) });
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
    const runtime = makeRuntime({ models });

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
    const runtime = makeRuntime({ models });
    const logPath = join(conversationDir, "log.jsonl");
    writeFileSync(
      logPath,
      `${JSON.stringify({ date: new Date().toISOString(), ts: "1", user: "U2", text: "before first turn" })}\n`,
    );

    const first = makeEventAndContext("2");
    await runtime.handleEvent(first.event, bot, first.context);

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

    const serialized = await sessionText("C123");
    expect(serialized.match(/between turns/g)).toHaveLength(1);
    expect(serialized).toContain("second reply");
  });
});

describe("ConversationRuntime lifecycle", () => {
  test("global refresh defers invalidation until the busy conversation settles", async () => {
    const { models, faux } = createFauxModels();
    const created: PiAgentWrapper[] = [];
    const runtime = makeRuntime({
      models,
      runnerFactory: async (options) => {
        const runner = await createRunner(options);
        created.push(runner);
        return runner;
      },
    });
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

    expect(created).toHaveLength(1);
    const oldRunner = created[0]!;
    const dispose = vi.spyOn(oldRunner, "dispose");

    expect(runtime.refreshAllConversations()).toEqual({ busy: [testAddress] });
    expect(runtime.refreshAllConversations()).toEqual({ busy: [testAddress] });
    expect(dispose).not.toHaveBeenCalled();

    release();
    await firstDone;
    expect(dispose).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);

    const second = makeEventAndContext("1000.1");
    await runtime.handleEvent(second.event, bot, second.context);

    expect(created).toHaveLength(2);
    expect(created[1]).not.toBe(oldRunner);
  });

  test("new dispatched inside the session queue does not deadlock", async () => {
    const { models } = createFauxModels();
    const runtime = makeRuntime({ models });
    await createSession();
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
    expect(await resetCount()).toBe(1);
  });

  test("new waits for the active run settlement before resetting and disposing", async () => {
    let settle!: () => void;
    const runGate = new Promise<void>((resolve) => (settle = resolve));
    const runner = fakeRunner();
    vi.mocked(runner.run).mockImplementation(async () => {
      await runGate;
      return { stopReason: "stop" };
    });
    const runtime = makeRuntime({ runnerFactory: fakeRunnerFactory(runner) });
    const { event, context } = makeEventAndContext("1000.2");
    const run = runtime.handleEvent(event, bot, context);
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledOnce());

    const reset = runtime.handleNewCommand(newCommandOptions());
    await vi.waitFor(() => expect(runner.abort).toHaveBeenCalledOnce());

    expect(await resetCount()).toBe(0);
    expect(runner.dispose).not.toHaveBeenCalled();
    expect(bot.postMessage).not.toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );

    settle();
    await run;
    await reset;

    await vi.waitFor(async () => {
      expect(await resetCount()).toBe(1);
    });
    expect(runner.dispose).toHaveBeenCalledOnce();
    expect(bot.postMessage).toHaveBeenCalledWith(
      "C123",
      "Conversation reset. Send a new message to start fresh.",
    );
  });

  test("force stop keeps a session running until its run settles", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime({ models });
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

  test("shutdown deadline aborts the run and posts a restart notice", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime({ models });
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([
      async () => {
        started = true;
        await gate;
        return fauxAssistantMessage("late");
      },
    ]);
    const { event, context } = makeEventAndContext("1000.4");
    const run = runtime.handleEvent(event, bot, context);
    await vi.waitFor(() => expect(started).toBe(true));

    const shutdown = runtime.shutdown(0);
    release();
    await run;
    await shutdown;

    expect(bot.postMessage).toHaveBeenCalledWith(
      "C123",
      expect.stringContaining("Restarting for an update"),
    );
    expect(runtime.isRunning(testAddress, "C123")).toBe(false);
  });

  test("new creates a clean session immediately without changing memory", async () => {
    const runner = fakeRunner();
    const runtime = makeRuntime({ runnerFactory: fakeRunnerFactory(runner) });
    const materialize = makeEventAndContext("2");
    await runtime.handleEvent(materialize.event, bot, materialize.context);
    const memoryPath = join(conversationDir, "MEMORY.md");
    writeFileSync(memoryPath, "stable anchor\n");

    await runtime.handleNewCommand(newCommandOptions());

    expect(await resetCount()).toBe(1);
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

    expect(await resetCount()).toBe(1);
    expect(runtime.getRunningSessions()).toEqual([]);
  });

  test("an old shared top-level session keeps serving new messages", async () => {
    const runner = fakeRunner();
    const runtime = makeRuntime({ runnerFactory: fakeRunnerFactory(runner) });
    await createSession();

    const { event, context } = makeEventAndContext("3");
    await runtime.handleEvent(event, bot, context);

    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.dispose).not.toHaveBeenCalled();
    expect(await resetCount()).toBe(0);
  });

  test("hands each settled run and its final reply to memory capture", async () => {
    const capture = vi.fn();
    const factory = vi.fn(() => ({ capture }));
    const { models } = createFauxModels();
    const runner = fakeRunner();
    const runtime = makeRuntime({
      models,
      memoryCapture: factory,
      runnerFactory: fakeRunnerFactory(runner),
    });
    vi.mocked(runner.run).mockResolvedValue({ stopReason: "stop", finalText: "Noted." });

    const { event, context } = makeEventAndContext("4");
    await runtime.handleEvent(event, bot, context);

    expect(factory).toHaveBeenCalledWith(models);
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        message: context.message,
        stopReason: "stop",
        reply: "Noted.",
        office: expect.objectContaining({ dir: conversationDir }),
      }),
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
    const sync = new ChatHistorySync({ isCommandText });
    await sync.resetSession({ office, sessionKey: "C123" });

    const syncOnce = async (file: string) => {
      const session = await SessionStore.open(office, file);
      try {
        await sync.syncSessionManager({
          office,
          sessionKey: "C123",
          sessionManager: session,
        });
      } finally {
        await session.close();
      }
    };

    const freshFile = "C123";
    await syncOnce(freshFile);
    expect(await sessionText(freshFile)).not.toContain('"text":"old"');

    writeFileSync(
      join(conversationDir, "log.jsonl"),
      JSON.stringify({ date: new Date().toISOString(), ts: "3", user: "U1", text: "new" }) + "\n",
      { flag: "a" },
    );
    await syncOnce(freshFile);
    expect(await sessionText(freshFile)).toContain("new");
  });

  test("new resets an idle session immediately", async () => {
    const { models } = createFauxModels();
    const runtime = makeRuntime({ models });
    await createSession();

    await runtime.handleNewCommand(newCommandOptions());

    await vi.waitFor(() => {
      expect(bot.postMessage).toHaveBeenCalledWith(
        "C123",
        "Conversation reset. Send a new message to start fresh.",
      );
    });
    expect(await resetCount()).toBe(1);
  });

  test("new and later top-level messages do not wait for a run in another session", async () => {
    let releaseThread!: () => void;
    const threadGate = new Promise<void>((resolve) => (releaseThread = resolve));
    const threadRunner = fakeRunner();
    vi.mocked(threadRunner.run).mockImplementation(async () => {
      await threadGate;
      return { stopReason: "stop" };
    });
    const topLevelRunner = fakeRunner();
    const runtime = makeRuntime({
      runnerFactory: vi.fn<RunnerFactory>(async (options) =>
        options.sessionKey === "C123" ? topLevelRunner : threadRunner,
      ),
    });
    await createSession();
    await registerThreadSession({ office, sessionKey: "C123:1000.5" });
    const thread = makeEventAndContext("task:1000.5");
    thread.event.thread_ts = "1000.5";
    thread.event.sessionKey = "C123:1000.5";
    thread.context.message.sessionKey = "C123:1000.5";
    thread.context.message.threadTs = "1000.5";
    const threadRun = runtime.handleEvent(thread.event, bot, thread.context);
    await vi.waitFor(() => expect(threadRunner.run).toHaveBeenCalledOnce());

    await runtime.handleNewCommand(newCommandOptions());
    const next = makeEventAndContext("1000.6");
    await runtime.handleEvent(next.event, bot, next.context);

    expect(await resetCount()).toBe(1);
    expect(topLevelRunner.run).toHaveBeenCalledOnce();
    expect(runtime.isRunning(testAddress, "C123:1000.5")).toBe(true);
    releaseThread();
    await threadRun;
  });
});

describe("ConversationRuntime compact command", () => {
  async function longChannel(
    runtime: ReturnType<typeof makeRuntime>,
    faux: ReturnType<typeof fauxProvider>,
  ) {
    for (let i = 0; i < 5; i++) {
      faux.setResponses([fauxAssistantMessage(`answer ${i} ${"detail ".repeat(2500)}`)]);
      const { event, context } = makeEventAndContext(`2000.${i}`);
      event.text = `question ${i} ${"context ".repeat(2500)}`;
      context.message.text = event.text;
      await runtime.handleEvent(event, bot, context);
    }
  }

  function compactCommand(text: string) {
    const { event, context } = makeEventAndContext("2000.9");
    event.text = text;
    context.message.text = text;
    return { event, context };
  }

  test("compact summarizes a shared conversation with the given instructions and reports the sizes", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime({ models });
    await longChannel(runtime, faux);
    let summaryRequest = "";
    faux.setResponses([
      (context) => {
        summaryRequest = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage("SUMMARY: five questions were answered.");
      },
    ]);
    const { event, context } = compactCommand("/compact keep the question numbers");

    await runtime.handleEvent(event, bot, context);

    expect(summaryRequest).toContain("keep the question numbers");
    expect(context.responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/Context compacted: about [\d,]+ → [\d,]+ tokens/),
      { style: "muted" },
    );
    const inspection = await SessionStore.inspect(office, "C123");
    expect(JSON.stringify((await inspection!.buildSessionContext()).messages[0])).toContain(
      "SUMMARY",
    );
  });

  test("compact reports when there is nothing to compact", async () => {
    const { models, faux } = createFauxModels();
    const runtime = makeRuntime({ models });
    faux.setResponses([fauxAssistantMessage("hi")]);
    const first = makeEventAndContext("2001.1");
    await runtime.handleEvent(first.event, bot, first.context);
    const calls = faux.state.callCount;
    const { event, context } = compactCommand("/compact");

    await runtime.handleEvent(event, bot, context);

    expect(faux.state.callCount).toBe(calls);
    expect(context.responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to compact yet"),
      { style: "muted" },
    );
  });
});

describe("ChatHistorySync session scope", () => {
  test("uses a pre-registered empty thread session for event anchors", async () => {
    const channelSession = await SessionStore.open(office, "C123");
    await channelSession.appendMessage({
      role: "user",
      content: [{ type: "text", text: "channel history should not leak" }],
      timestamp: 1,
    });
    await channelSession.close();
    await registerThreadSession({
      office,
      sessionKey: "C123:2000.0001",
    });

    const sessionScope = await new ChatHistorySync({ isCommandText }).resolveSessionScope({
      office,
      sessionKey: "C123:2000.0001",
    });

    expect(sessionScope.threadRootMessage).toBeNull();
    expect(await sessionText("C123:2000.0001")).not.toContain("channel history should not leak");
  });
});
