import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { Type, type TSchema } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  defineExtension,
  defineTask,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { createWorkspace, createOfficeAddress } from "../office/index.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MikanModels } from "../harness/models.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import { SessionStore } from "../sessions/session-store.js";
import { MikanAgentSession } from "../harness/session.js";
import * as log from "../log.js";
import type {
  SlackSocketConnection,
  SlackSocketEventArgs,
  SlackWebApi,
} from "../adapters/slack/types.js";
import { runtimeServices } from "./runtime-services.js";
import { localRunnerFactory } from "./local-execution.js";

const beforePromptPayload = vi.fn(async () => {});
vi.mock("../harness/prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/prompt.js")>();
  return {
    ...actual,
    buildPromptPayload: async (...args: Parameters<typeof actual.buildPromptPayload>) => {
      await beforePromptPayload();
      return actual.buildPromptPayload(...args);
    },
  };
});

class FakeSlackSocket implements SlackSocketConnection {
  private readonly listeners = new Map<string, Array<(args: SlackSocketEventArgs) => unknown>>();

  on(event: string, listener: (args: SlackSocketEventArgs) => unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async start(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async deliver(event: string, payload: unknown): Promise<void> {
    const args: SlackSocketEventArgs = { event: payload, ack: async () => {} };
    await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(args)));
  }
}

const ok = async () => ({ ok: true });

function fakeSlackWebApi(): SlackWebApi {
  return {
    auth: { test: async () => ({ ok: true, user_id: "BOT" }) },
    chat: { postMessage: ok, postEphemeral: ok, update: ok, delete: ok },
    conversations: {
      open: ok,
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
      list: async () => ({ ok: true, channels: [] }),
    },
    users: { list: async () => ({ ok: true, members: [] }) },
    reactions: { add: ok },
    files: { uploadV2: async () => ({ ok: true, files: [] }) },
    apiCall: ok,
  };
}

async function startAfterEpoch(slack: SlackMessagingBot): Promise<void> {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await slack.start();
  } finally {
    now.mockRestore();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let dir: string;
let models: MikanModels;
let faux: ReturnType<typeof fauxProvider>;
let workspace: ReturnType<typeof createWorkspace>;
let runtime: ReturnType<typeof createConversationRuntime>;
let bot: SlackMessagingBot;
let socket: FakeSlackSocket;
let hold: ReturnType<typeof deferred>;
let started: ReturnType<typeof deferred>;
let aborted: boolean;
let trace: string[];
let id: number;
const address = createOfficeAddress("slack", "C123");
const eventTs = () => `${Math.floor(Date.now() / 1000)}.${String(++id).padStart(6, "0")}`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mikan-task-simulation-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  createGlobalSettingsFile(stateDir);
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
  workspace = createWorkspace({ root: dir, stateDir });
  workspace.office(address).ensure();
  models = MikanModels.create({ modelsJsonPath: join(stateDir, "models.json") });
  faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  hold = deferred();
  started = deferred();
  aborted = false;
  trace = [];
  id = 0;
  const tool: ToolRegistration<TSchema> = {
    name: "hold",
    description: "Controlled long-running operation",
    parameters: Type.Object({}),
    execute: async (_args, _api, { abortSignal: signal }) => {
      trace.push("tool:start");
      started.resolve();
      const cancel = () => {
        aborted = true;
        trace.push("tool:abort");
        hold.resolve();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await hold.promise;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      trace.push("tool:end");
      return { output: [{ type: "text", text: "operation finished" }], details: {} };
    },
  };
  runtime = createConversationRuntime({
    workspace,
    models,
    ...runtimeServices(workspace.stateDir),
    runnerFactory: localRunnerFactory,
    platformToolPackFactories: [() => ({ tools: [tool], bindRun: () => {} })],
  });
  socket = new FakeSlackSocket();
  bot = new SlackMessagingBot(runtime, {
    appToken: "test",
    botToken: "test",
    workspace,
    webApi: fakeSlackWebApi(),
    socket,
  });
  await startAfterEpoch(bot);
  vi.spyOn(bot, "postMessage").mockImplementation(async (_c, text, thread) => {
    trace.push(`post:${thread ?? "channel"}:${text}`);
    return eventTs();
  });
  vi.spyOn(bot, "updateMessage").mockImplementation(async (_c, ts, text) => {
    trace.push(`update:${ts}:${text}`);
  });
  vi.spyOn(bot, "setAssistantStatus").mockResolvedValue(undefined);
  vi.spyOn(bot, "tryReserveStreamStart").mockReturnValue(false);
});
afterEach(async () => {
  hold.resolve();
  await bot.stop();
  await runtime.shutdown();

  vi.restoreAllMocks();
  beforePromptPayload.mockReset();
  rmSync(dir, { recursive: true, force: true });
});
const callHold = () => fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });

async function dm(text: string, thread_ts?: string) {
  await socket.deliver("message", {
    text,
    channel: "D123",
    user: "U1",
    ts: eventTs(),
    thread_ts,
    channel_type: "im",
  });
}
const THREAD = "100.1";
async function startRun(thread_ts?: string) {
  await dm("investigate this", thread_ts);
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
}

test("slow stop acknowledgement is finalized even when the run settles before its id arrives", async () => {
  faux.setResponses([callHold()]);
  await startRun(THREAD);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  vi.mocked(bot.postMessage).mockImplementation(async (_channel, text) => {
    if (text.includes("Stopping")) {
      await gate;
      return "STOP_ACK";
    }
    return eventTs();
  });
  const stop = runtime.handleStop(createOfficeAddress("slack", "D123"), `D123:${THREAD}`, bot);
  try {
    await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  } finally {
    release();
    await stop;
  }
  expect(bot.updateMessage).toHaveBeenCalledWith(
    "D123",
    "STOP_ACK",
    expect.stringContaining("Stopped"),
  );
});

test("stop notice lands in log.jsonl so history search finds why a run ended", async () => {
  faux.setResponses([callHold()]);
  await startRun(THREAD);
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  const stop = runtime.handleStop(
    createOfficeAddress("slack", "D123"),
    `D123:${THREAD}`,
    bot,
    THREAD,
  );
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  await stop;
  const entries = readFileSync(office.logPath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const stopped = entries.filter(
    (e) => e.user === "bot" && typeof e.text === "string" && e.text.includes("Stopped"),
  );
  expect(stopped).toHaveLength(1);
  expect(stopped[0]?.threadTs).toBe(THREAD);
});

test("stop during final presentation settles its acknowledgement even after Pi completed", async () => {
  faux.setResponses([callHold(), fauxAssistantMessage("FINISHED_TEXT")]);
  await startRun(THREAD);
  const presenting = deferred();
  const releasePresentation = deferred();
  vi.mocked(bot.updateMessage).mockImplementation(async (_channel, _ts, text) => {
    if (text.includes("FINISHED_TEXT")) {
      presenting.resolve();
      await releasePresentation.promise;
    }
  });
  hold.resolve();
  await presenting.promise;
  vi.mocked(bot.postMessage).mockResolvedValue("FINAL_STOP_ACK");
  const stop = runtime.handleStop(createOfficeAddress("slack", "D123"), `D123:${THREAD}`, bot);
  try {
    await vi.waitFor(() =>
      expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("Stopping")),
    );
  } finally {
    releasePresentation.resolve();
    await stop;
  }
  expect(bot.updateMessage).toHaveBeenCalledWith(
    "D123",
    "FINAL_STOP_ACK",
    expect.stringContaining("Stopped"),
  );
});

test("thread stop keeps acknowledgement and settlement in the thread", async () => {
  faux.setResponses([callHold()]);
  await startRun(THREAD);
  await dm("stop", THREAD);
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(aborted).toBe(true);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("Stopping"), THREAD);
  expect(
    vi.mocked(bot.postMessage).mock.calls.filter((c) => !c[2] && /Stopp/.test(c[1])),
  ).toHaveLength(0);
});

test("shared-channel bare thread stop reaches control intake and never replies top-level", async () => {
  faux.setResponses([callHold()]);
  await socket.deliver("app_mention", {
    text: "<@BOT> wait",
    channel: "C123",
    user: "U1",
    ts: eventTs(),
    thread_ts: THREAD,
  });
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  await socket.deliver("message", {
    text: "stop",
    channel: "C123",
    user: "U1",
    ts: eventTs(),
    thread_ts: THREAD,
    channel_type: "channel",
  });
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(aborted).toBe(true);
  expect(bot.postMessage).toHaveBeenCalledWith("C123", expect.stringContaining("Stopping"), THREAD);
  expect(
    vi.mocked(bot.postMessage).mock.calls.filter((c) => !c[2] && /Stopp/.test(c[1])),
  ).toHaveLength(0);
});

test("stop during runner preparation prevents provider and tool execution", async () => {
  faux.setResponses([callHold(), fauxAssistantMessage("done")]);
  await startRun(THREAD);
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const preparing = deferred();
  const release = deferred();
  beforePromptPayload.mockImplementationOnce(async () => {
    preparing.resolve();
    await release.promise;
  });
  faux.setResponses([fauxAssistantMessage("SHOULD_NOT_RUN")]);
  await dm("continue with work", THREAD);
  await preparing.promise;
  const stop = runtime.handleStop(
    createOfficeAddress("slack", "D123"),
    `D123:${THREAD}`,
    bot,
    THREAD,
  );
  release.resolve();
  await stop;
  expect(faux.state.callCount).toBe(2);
});

test("long work asked at the top level runs in that conversation, and the next message waits for it", async () => {
  let offered: string[] = [];
  faux.setResponses([
    (context) => {
      offered = getCurrentTools(context.messages).map((tool) => tool.name);
      return callHold();
    },
    fauxAssistantMessage("work finished"),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("好了嗎");
      return fauxAssistantMessage("yes, it finished");
    },
  ]);
  await startRun();
  expect(offered).not.toContain("start_task");
  expect(offered).not.toContain("task_status");
  expect(runtime.getRunningSessions().map((s) => s.sessionKey)).toEqual(["D123"]);

  await vi.waitFor(() => expect(trace.filter((line) => line.startsWith("post:"))).toHaveLength(1));
  await dm("好了嗎？");
  expect(faux.state.callCount).toBe(1);
  expect(trace.filter((line) => line.startsWith("post:"))).toHaveLength(1);
  hold.resolve();

  await vi.waitFor(() =>
    expect(trace.some((line) => line.includes("yes, it finished"))).toBe(true),
  );
  const lines = trace.join("\n");
  expect(lines.indexOf("work finished")).toBeLessThan(lines.indexOf("yes, it finished"));
  expect(trace.some((line) => line.includes("<@U1>"))).toBe(false);
});

const dmOffice = () => workspace.office(createOfficeAddress("slack", "D123"));

async function interruptRun(sessionKey: string): Promise<void> {
  const office = dmOffice();
  office.ensure();
  appendFileSync(
    office.logPath,
    `${JSON.stringify({ date: new Date().toISOString(), ts: "1.000001", user: "U1", userName: "u1", text: "investigate", isMessagingBot: false, sessionKey })}\n`,
  );
  const store = await SessionStore.open(office, sessionKey);
  let toolStarted!: () => void;
  const toolRunning = new Promise<void>((resolve) => (toolStarted = resolve));
  const slow: ToolRegistration = {
    name: "slow",
    description: "Runs until the store closes",
    parameters: Type.Object({}),
    execute: async (_params, _api, { abortSignal: signal }) => {
      toolStarted();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { output: [{ type: "text", text: "never" }], details: undefined };
    },
  };
  faux.setResponses([fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })]);
  const run = new MikanAgentSession({
    model: faux.getModel(),
    models,
    sessionStore: store,
    tools: [slow],
    thinkingLevel: "off",
    systemPrompt: "prompt",
    settings: { compaction: { enabled: false } },
  })
    .prompt("long work")
    .catch(() => undefined);
  await toolRunning;
  await store.close();
  await run;
}

async function restartSlack(): Promise<SlackMessagingBot> {
  const api = fakeSlackWebApi();
  api.conversations.list = async (args) => ({
    ok: true,
    channels: (args as { types?: string }).types === "im" ? [{ id: "D123", user: "U1" }] : [],
  });
  const restarted = new SlackMessagingBot(runtime, {
    appToken: "test",
    botToken: "test",
    workspace,
    webApi: api,
    socket: new FakeSlackSocket(),
  });
  vi.spyOn(restarted, "postMessage").mockImplementation(async (_c, text, thread) => {
    trace.push(`post:${thread ?? "channel"}:${text}`);
    return eventTs();
  });
  vi.spyOn(restarted, "updateMessage").mockImplementation(async (_c, ts, text) => {
    trace.push(`update:${ts}:${text}`);
  });
  vi.spyOn(restarted, "setAssistantStatus").mockResolvedValue(undefined);
  vi.spyOn(restarted, "tryReserveStreamStart").mockReturnValue(false);
  await restarted.start();
  return restarted;
}

test("a thread run interrupted by a restart continues in its thread and finishes", async () => {
  await interruptRun("D123:1700000000.000001");
  let continuedWith = "";
  faux.setResponses([
    (context) => {
      continuedWith = JSON.stringify(context.messages);
      return fauxAssistantMessage("continued result");
    },
  ]);
  const restarted = await restartSlack();
  try {
    await vi.waitFor(() =>
      expect(trace.some((line) => line.includes("continued result"))).toBe(true),
    );
    expect(continuedWith).toContain("Tool slow was interrupted");
    expect(
      trace.some((line) => line.startsWith("post:1700000000.000001:") && /restart/i.test(line)),
    ).toBe(true);
  } finally {
    await restarted.stop();
  }
});

test("a direct-message reply interrupted by a restart continues in the conversation", async () => {
  await interruptRun("D123");
  faux.setResponses([fauxAssistantMessage("continued reply")]);
  const restarted = await restartSlack();
  try {
    await vi.waitFor(() =>
      expect(trace.some((line) => line.includes("continued reply"))).toBe(true),
    );
    expect(trace.some((line) => line.startsWith("post:channel:") && /restart/i.test(line))).toBe(
      true,
    );
  } finally {
    await restarted.stop();
  }
});

test("a restart with nothing interrupted continues nothing", async () => {
  const info = vi.spyOn(log, "logInfo");
  await (await SessionStore.open(dmOffice(), "D123")).close();
  const restarted = await restartSlack();
  try {
    expect(info.mock.calls.some((c) => String(c[0]).includes("Continued 0 interrupted runs"))).toBe(
      true,
    );
    expect(faux.state.callCount).toBe(0);
  } finally {
    await restarted.stop();
  }
});

test("shutdown leaves a running Slack run for the next process instead of waiting for it", async () => {
  faux.setResponses([callHold()]);
  await startRun();
  const startedAt = Date.now();
  await bot.stop();
  await runtime.shutdown(60_000);
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(aborted).toBe(false);
  expect(trace).not.toContain("tool:end");
});

const TaskAnchorBeforeRemoval = defineTask<{ acknowledgement: string }, { phase: "done" }, null>({
  name: "mikan.task-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_task, taskRuntime, taskContext) =>
      taskRuntime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        taskContext,
      ),
  },
  abort: (_task, taskRuntime, taskContext) =>
    taskRuntime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});
const SessionIndexBeforeRemoval = defineDoc<{
  sessions: Record<string, { conversationId: number; id: string; createdAt: number }>;
}>({
  kind: "mikan.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
  checkpointWhen: () => false,
});

async function writeFinishedTaskThread(root: string): Promise<void> {
  const office = dmOffice();
  office.ensure();
  const requester = await SessionStore.open(office, "D123");
  const attached = await requester.bindHarness({ models: models.models });
  attached.registry.install(
    defineExtension({ name: "mikan.task-anchors", tasks: [TaskAnchorBeforeRemoval] }),
  );
  const anchor = await attached.conversation.commit(async (tx) => {
    const taskId = await tx.createTask(
      TaskAnchorBeforeRemoval,
      { acknowledgement: "On it." },
      { ownership: { kind: "conversation" }, background: true },
    );
    const child = await tx.createConversation({ ownership: { kind: "task", taskId } });
    (await tx.doc(SessionIndexBeforeRemoval)).sessions[`D123:${root}`] = {
      conversationId: child.id,
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: Date.now(),
    };
    return taskId;
  }, BACKGROUND_CONTEXT);
  await attached.harness.waitForTask(anchor, BACKGROUND_CONTEXT);
  await requester.close();

  const thread = await SessionStore.open(office, `D123:${root}`);
  await thread.appendMessage({ role: "user", content: "LONG TASK CONTEXT", timestamp: 1 });
  await thread.appendCustomEntry("mikan.control_input", { messageId: "1.000002" });
  await thread.close();
}

test("a task thread written before task threads were removed is answered as an ordinary thread", async () => {
  const root = "1700000000.000001";
  await writeFinishedTaskThread(root);
  let seen = "";
  faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("it finished earlier");
    },
    fauxAssistantMessage("top-level answer"),
  ]);

  await dm("好了嗎？", root);
  await vi.waitFor(() =>
    expect(trace.some((line) => line.includes("it finished earlier"))).toBe(true),
  );
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(seen).toContain("LONG TASK CONTEXT");
  expect(seen).toContain("好了嗎");
  expect(trace.some((line) => line.startsWith(`post:${root}:`))).toBe(true);
  expect(trace.some((line) => line.includes("<@U1>"))).toBe(false);

  await dm("and a new question");
  await vi.waitFor(() =>
    expect(trace.some((line) => line.includes("top-level answer"))).toBe(true),
  );
  const requester = await SessionStore.inspect(dmOffice(), "D123");
  expect(JSON.stringify((await requester!.buildSessionContext()).messages)).not.toContain(
    "background task",
  );
  expect(await SessionStore.continueInterrupted(dmOffice())).toEqual([]);
});
