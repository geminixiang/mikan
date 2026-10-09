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
import { type AgentTool } from "@earendil-works/pi-agent-core";
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
import { JevNotConfiguredError } from "../harness/jev.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import * as observability from "../observability/index.js";
import { querySlackTasks, isTaskStatusQuestion } from "../adapters/slack/task-status.js";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import { SessionStore } from "../sessions/session-store.js";
import * as log from "../log.js";
import type {
  SlackSocketConnection,
  SlackSocketEventArgs,
  SlackWebApi,
} from "../adapters/slack/types.js";

const jev = vi.fn();
vi.mock("../harness/jev.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/jev.js")>();
  return { ...actual, evaluateWithJev: (...args: unknown[]) => jev(...args) };
});
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
const jevChoice = (choice: string) =>
  jev.mockResolvedValueOnce({ answers: { intent: { type: "choice", choice } } });

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
    views: { publish: ok },
    files: { uploadV2: async () => ({ ok: true, files: [] }) },
    assistant: { threads: { setSuggestedPrompts: ok, setTitle: ok } },
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
  jev.mockReset();
  jev.mockRejectedValue(new JevNotConfiguredError());
  hold = deferred();
  started = deferred();
  aborted = false;
  trace = [];
  id = 0;
  const tool: AgentTool<TSchema> = {
    name: "hold",
    label: "hold",
    description: "Controlled long-running operation",
    parameters: Type.Object({}),
    execute: async (_id, _args, signal) => {
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
      return { content: [{ type: "text", text: "operation finished" }], details: {} };
    },
  };
  runtime = createConversationRuntime({
    workspace,
    sandbox: { type: "host" },
    models,
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
async function startTask() {
  await dm("investigate this");
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  const key = runtime
    .getRunningSessions()
    .find((s) => s.sessionKey.startsWith("D123:"))!.sessionKey;
  return key.slice(5);
}
const handoff = () =>
  fauxAssistantMessage(
    fauxToolCall("start_task", { message: "On it, continuing here.", task: "LONG TASK CONTEXT" }),
    { stopReason: "toolUse" },
  );

test("DM handoff preserves acknowledgement, answers other chat, and steers active task", async () => {
  faux.setResponses([
    handoff(),
    callHold(),
    fauxAssistantMessage("quick answer"),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("READ_ONLY_UPDATE");
      return fauxAssistantMessage("task adjusted");
    },
  ]);
  const root = await startTask();
  await dm("independent quick question");
  await vi.waitFor(() =>
    expect(vi.mocked(bot.updateMessage).mock.calls.some((c) => c[2].includes("quick answer"))).toBe(
      true,
    ),
  );
  expect(trace).not.toContain("tool:end");
  await dm("READ_ONLY_UPDATE", root);
  expect(faux.state.callCount).toBe(3);
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(vi.mocked(bot.updateMessage).mock.calls.some((c) => c[1] === root)).toBe(false);
  expect(vi.mocked(bot.postMessage).mock.calls.some((c) => c[2] === root)).toBe(true);
});

test("stop discards pending steering and history sync cannot resurrect it on continuation", async () => {
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  await dm("CANCELLED_INSTRUCTION", root);
  await dm("stop", root);
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(aborted).toBe(true);
  expect(faux.state.callCount).toBe(2);
  faux.setResponses([
    (context) => {
      const text = JSON.stringify(context.messages);
      expect(text).toContain("LONG TASK CONTEXT");
      expect(text).not.toContain("CANCELLED_INSTRUCTION");
      expect(text).toContain("NEW_LIMIT");
      return fauxAssistantMessage("continued");
    },
  ]);
  await dm("continue with NEW_LIMIT", root);
  await vi.waitFor(() => expect(faux.state.callCount).toBe(3));
});

test("slow stop acknowledgement is finalized even when task settles before its id arrives", async () => {
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  vi.mocked(bot.postMessage).mockImplementation(async (_channel, text) => {
    if (text.includes("Stopping")) {
      await gate;
      return "STOP_ACK";
    }
    return eventTs();
  });
  const stop = runtime.handleStop(createOfficeAddress("slack", "D123"), `D123:${root}`, bot);
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
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  const stop = runtime.handleStop(createOfficeAddress("slack", "D123"), `D123:${root}`, bot, root);
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
  expect(stopped[0]?.threadTs).toBe(root);
});

test("stop during final presentation settles its acknowledgement even after Pi completed", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("FINISHED_TEXT")]);
  const root = await startTask();
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
  const stop = runtime.handleStop(createOfficeAddress("slack", "D123"), `D123:${root}`, bot);
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

test("thread stop keeps acknowledgement and settlement in the task thread", async () => {
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  await dm("stop", root);
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("Stopping"), root);
  expect(
    vi.mocked(bot.postMessage).mock.calls.filter((c) => !c[2] && /Stopp/.test(c[1])),
  ).toHaveLength(0);
});

test("completed task posts exactly one new requester mention; cancelled task does not", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("finished result")]);
  const root = await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const notices = vi
    .mocked(bot.postMessage)
    .mock.calls.filter((c) => c[2] === root && c[1].includes("<@U1>"));
  expect(notices).toHaveLength(1);
  faux.setResponses([callHold()]);
  hold = deferred();
  trace = [];
  await dm("run again", root);
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  await dm("stop", root);
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(
    vi.mocked(bot.postMessage).mock.calls.filter((c) => c[2] === root && c[1].includes("<@U1>")),
  ).toHaveLength(1);
});

test("shared-channel bare thread stop reaches control intake and never replies top-level", async () => {
  faux.setResponses([callHold()]);
  await socket.deliver("app_mention", {
    text: "<@BOT> wait",
    channel: "C123",
    user: "U1",
    ts: eventTs(),
    thread_ts: "100.1",
  });
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  await socket.deliver("message", {
    text: "stop",
    channel: "C123",
    user: "U1",
    ts: eventTs(),
    thread_ts: "100.1",
    channel_type: "channel",
  });
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(aborted).toBe(true);
  expect(bot.postMessage).toHaveBeenCalledWith(
    "C123",
    expect.stringContaining("Stopping"),
    "100.1",
  );
  expect(
    vi.mocked(bot.postMessage).mock.calls.filter((c) => !c[2] && /Stopp/.test(c[1])),
  ).toHaveLength(0);
});

test("failed task does not send a completion mention", async () => {
  faux.setResponses([
    handoff(),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" }),
  ]);
  await dm("investigate this");
  await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(vi.mocked(bot.postMessage).mock.calls.filter((c) => c[1].includes("<@U1>"))).toHaveLength(
    0,
  );
});

test("status questions in an active task are read-only, immediate, and do not add model calls", async () => {
  faux.setResponses([
    handoff(),
    callHold(),
    (context) => {
      expect(JSON.stringify(context.messages)).not.toContain("好了嗎");
      return fauxAssistantMessage("done");
    },
  ]);
  const root = await startTask();
  await dm("好了嗎？", root);
  await dm("還要多久？", root);
  expect(faux.state.callCount).toBe(2);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("還在處理"), root);
  expect(bot.postMessage).toHaveBeenCalledWith(
    "D123",
    expect.stringContaining("無法可靠估計"),
    root,
  );
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const messagesBefore = vi
    .mocked(bot.postMessage)
    .mock.calls.filter((c) => c[1].includes("<@U1>")).length;
  await dm("好了嗎？", root);
  expect(faux.state.callCount).toBe(3);
  expect(bot.postMessage).toHaveBeenCalledWith(
    "D123",
    expect.stringContaining("這一輪執行已結束"),
    root,
  );
  expect(vi.mocked(bot.postMessage).mock.calls.filter((c) => c[1].includes("<@U1>"))).toHaveLength(
    messagesBefore,
  );
});

test("a status question answered as the completion notice goes out does not say the task is running", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const root = await startTask();
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  let statusAtCompletion: string | undefined;
  const post = vi.mocked(bot.postMessage).getMockImplementation();
  vi.mocked(bot.postMessage).mockImplementation(async (channel, text, threadTs) => {
    if (text.includes("這一輪處理已結束")) {
      const [task] = await querySlackTasks(
        office,
        "D123",
        runtime.getRunningSessions(),
        `D123:${root}`,
      );
      statusAtCompletion = task?.status;
    }
    return post ? post(channel, text, threadTs) : "1.1";
  });

  hold.resolve();
  await vi.waitFor(() => expect(statusAtCompletion).toBeDefined());

  expect(statusAtCompletion).toBe("completed");
});

test("main DM task_status reads live work and persisted completion without reopening writer", async () => {
  let observed = "";
  faux.setResponses([
    handoff(),
    callHold(),
    fauxAssistantMessage(fauxToolCall("task_status", {}), { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.findLast(
        (m) => m.role === "toolResult" && m.toolName === "task_status",
      );
      observed =
        result && Array.isArray(result.content)
          ? result.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("")
          : "";
      return fauxAssistantMessage("still running");
    },
    fauxAssistantMessage("done"),
  ]);
  const root = await startTask();
  await dm("how is the task?");
  await vi.waitFor(() => expect(observed).toContain('"status":"running"'));
  expect(vi.mocked(bot.updateMessage).mock.calls.some((c) => c[2].includes("✓ task_status"))).toBe(
    false,
  );
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  const result = await querySlackTasks(office, "D123", [], `D123:${root}`);
  expect(result[0]?.status).toBe("completed");
  expect(result[0]?.endedAt).toBeDefined();
  expect(await querySlackTasks(office, "D123", [], "OTHER:123")).toEqual([]);
});

test("ordinary task-thread followup without work does not send another completion mention", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const root = await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const before = vi.mocked(bot.postMessage).mock.calls.filter((c) => c[1].includes("<@U1>")).length;
  faux.setResponses([fauxAssistantMessage("short summary")]);
  await dm("give me the short version", root);
  await vi.waitFor(() => expect(faux.state.callCount).toBe(4));
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(vi.mocked(bot.postMessage).mock.calls.filter((c) => c[1].includes("<@U1>"))).toHaveLength(
    before,
  );
});

test("mixed status and instructions are not swallowed by the observation shortcut", () => {
  expect(isTaskStatusQuestion("好了嗎？")).toBe(true);
  expect(isTaskStatusQuestion("好了嗎？先不要部署")).toBe(false);
  expect(isTaskStatusQuestion("先給我重點就好")).toBe(false);
});

test("jev answers a status question the regex misses from observation, with task context", async () => {
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  jevChoice("status");
  await dm("弄好了沒", root);
  expect(faux.state.callCount).toBe(2);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("還在處理"), root);
  const state = jev.mock.calls[0]?.[0] as string;
  expect(state).toContain("- running (currently: hold): On it, continuing here.");
  expect(state).toContain("NEW message from U1:\n弄好了沒");
  expect(jev.mock.calls[0]?.[1]).toMatchObject({ intent: { type: "choice" } });
});

test("jev routes a mixed status-plus-instruction thread message to steering, not observation", async () => {
  faux.setResponses([
    handoff(),
    callHold(),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("先不要部署");
      return fauxAssistantMessage("adjusted");
    },
  ]);
  const root = await startTask();
  jevChoice("steer");
  await dm("好了嗎？先不要部署", root);
  expect(faux.state.callCount).toBe(2);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("收到補充"), root);
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(faux.state.callCount).toBe(3);
});

test("jev steers a top-level DM supplement into the single running task", async () => {
  faux.setResponses([
    handoff(),
    callHold(),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("TOP_LEVEL_SUPPLEMENT");
      return fauxAssistantMessage("adjusted");
    },
  ]);
  await startTask();
  jevChoice("steer");
  await dm("TOP_LEVEL_SUPPLEMENT");
  expect(faux.state.callCount).toBe(2);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("收到補充"));
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(faux.state.callCount).toBe(3);
});

test("top-level DM falls through to a normal turn when jev says request, and skips jev when idle", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("quick answer")]);
  await startTask();
  jevChoice("request");
  await dm("unrelated question");
  await vi.waitFor(() => expect(faux.state.callCount).toBe(3));
  expect(jev).toHaveBeenCalledTimes(1);
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  faux.setResponses([fauxAssistantMessage("another answer")]);
  await dm("and one more");
  await vi.waitFor(() => expect(faux.state.callCount).toBe(4));
  expect(jev).toHaveBeenCalledTimes(1);
});

test("rejected final delivery never sends a completion mention", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("UNDELIVERED_FINAL")]);
  const root = await startTask();
  const rejected = vi.fn();
  vi.mocked(bot.updateMessage).mockImplementation(async (_channel, _ts, text) => {
    if (text.includes("UNDELIVERED_FINAL")) {
      rejected();
      throw new Error("final rejected");
    }
  });
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(rejected).toHaveBeenCalled();
  expect(
    vi.mocked(bot.postMessage).mock.calls.filter((c) => c[2] === root && c[1].includes("<@U1>")),
  ).toHaveLength(0);
});

test("stop during runner preparation prevents provider and tool execution", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const root = await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const preparing = deferred();
  const release = deferred();
  beforePromptPayload.mockImplementationOnce(async () => {
    preparing.resolve();
    await release.promise;
  });
  faux.setResponses([fauxAssistantMessage("SHOULD_NOT_RUN")]);
  await dm("continue with work", root);
  await preparing.promise;
  const stop = runtime.handleStop(createOfficeAddress("slack", "D123"), `D123:${root}`, bot, root);
  release.resolve();
  await stop;
  expect(faux.state.callCount).toBe(3);
});

test("status between admission and run start reports queued, not unknown", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  const preparing = deferred();
  const release = deferred();
  beforePromptPayload.mockImplementation(async () => {
    if ((await SessionStore.listTasks(office, "D123")).length === 0) return;
    preparing.resolve();
    await release.promise;
  });
  await dm("investigate this");
  await preparing.promise;
  const root = (await SessionStore.listTasks(office, "D123"))[0]!.sessionKey.slice("D123:".length);
  const before = await querySlackTasks(office, "D123", [], `D123:${root}`);
  expect(before[0]?.status).toBe("queued");
  beforePromptPayload.mockReset();
  release.resolve();
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const after = await querySlackTasks(office, "D123", [], `D123:${root}`);
  expect(after[0]?.status).toBe("completed");
});

test("recent status listing keeps an older active task even with ten newer task roots", async () => {
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  for (let i = 0; i < 11; i++) {
    const later = await SessionStore.openTask(office, `D123:9999999999.${i}`, "D123", {
      acknowledgement: `later ${i}`,
    });
    await later.close();
  }
  const observations = await querySlackTasks(office, "D123", runtime.getRunningSessions());
  expect(observations.find((t) => t.threadTs === root)?.status).toBe("running");
});

test("initial delegated reasoning-only task still notifies its requester", async () => {
  faux.setResponses([handoff(), fauxAssistantMessage("reasoned answer")]);
  await dm("think through this task");
  await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  expect(vi.mocked(bot.postMessage).mock.calls.filter((c) => c[1].includes("<@U1>"))).toHaveLength(
    1,
  );
});

test("status isolates platform identity", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const root = await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  const observations = await querySlackTasks(
    office,
    "D123",
    [
      {
        address: createOfficeAddress("discord", "D123"),
        sessionKey: `D123:${root}`,
        startedAt: Date.now(),
        currentTool: "WRONG_PLATFORM",
      },
    ],
    `D123:${root}`,
  );
  expect(observations[0]?.status).toBe("completed");
  expect(observations[0]?.currentTool).toBeUndefined();
});

test("tasks and their acknowledgements are read from the task record, not the office log", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const root = await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  rmSync(office.logPath);

  const [task] = await querySlackTasks(office, "D123", []);

  expect(task).toMatchObject({
    sessionKey: `D123:${root}`,
    threadTs: root,
    acknowledgement: "On it, continuing here.",
    status: "completed",
  });
  const calls = faux.state.callCount;
  await dm("好了嗎？", root);
  expect(bot.postMessage).toHaveBeenCalledWith(
    "D123",
    expect.stringContaining("這一輪執行已結束"),
    root,
  );
  expect(faux.state.callCount).toBe(calls);
});

test("main DM pure status observes the single active task without a model turn", async () => {
  faux.setResponses([handoff(), callHold()]);
  await startTask();
  await dm("好了嗎？");
  expect(faux.state.callCount).toBe(2);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("還在處理"));
});

test("main DM status does not guess between concurrent tasks", async () => {
  faux.setResponses([handoff(), callHold(), handoff(), callHold()]);
  await startTask();
  await dm("another investigation");
  await vi.waitFor(() =>
    expect(
      runtime.getRunningSessions().filter((s) => s.sessionKey.startsWith("D123:")),
    ).toHaveLength(2),
  );
  await vi.waitFor(() => expect(faux.state.callCount).toBe(4));
  await dm("好了嗎？");
  expect(faux.state.callCount).toBe(4);
  expect(bot.postMessage).toHaveBeenCalledWith("D123", expect.stringContaining("多個任務"));
});

test("task admission failure is reported without tool payload content", async () => {
  const report = vi.spyOn(observability, "reportUserFacingError");
  vi.mocked(bot.postMessage).mockRejectedValueOnce(new Error("anchor rejected"));
  faux.setResponses([handoff(), fauxAssistantMessage("unable to start")]);
  await dm("investigate this");
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "admit_task" }),
    ),
  );
  const admission = report.mock.calls.find((c) => c[1].operation === "admit_task");
  expect(JSON.stringify(admission)).not.toContain("LONG TASK CONTEXT");
});

const dmOffice = () => workspace.office(createOfficeAddress("slack", "D123"));
const DAY_SECONDS = 24 * 60 * 60;

async function interruptedTask(
  options: { ageSeconds?: number; ended?: boolean; legacy?: boolean } = {},
) {
  const office = dmOffice();
  office.ensure();
  const now = Date.now();
  const root = `${Math.floor(now / 1000) - (options.ageSeconds ?? 60)}.000001`;
  const line = (entry: object) => appendFileSync(office.logPath, `${JSON.stringify(entry)}\n`);
  line({
    date: new Date(now).toISOString(),
    ts: "1.000001",
    user: "U1",
    userName: "u1",
    text: "investigate",
    isMessagingBot: false,
  });
  line({
    date: new Date(now).toISOString(),
    ts: root,
    user: "bot",
    text: "On it.",
    isMessagingBot: true,
    taskRoot: true,
  });
  await (await SessionStore.open(office, "D123")).close();
  const task = await SessionStore.openTask(office, `D123:${root}`, "D123", {
    acknowledgement: "On it.",
  });
  if (!options.legacy) await task.recordRun({ startedAt: now - (options.ageSeconds ?? 60) * 1000 });
  if (options.ended) await task.recordRun({ endedAt: now, status: "completed" });
  await task.close();
  return root;
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

test("a task interrupted by a restart resumes in its thread and finishes", async () => {
  const root = await interruptedTask();
  let resumedWith = "";
  faux.setResponses([
    (context) => {
      resumedWith = JSON.stringify(context.messages);
      return fauxAssistantMessage("resumed result");
    },
  ]);
  const restarted = await restartSlack();
  try {
    await vi.waitFor(() =>
      expect(trace.some((line) => line.includes("resumed result"))).toBe(true),
    );
    expect(resumedWith).toMatch(/restarted/i);
    expect(trace.some((line) => line.startsWith(`post:${root}:`) && /restart/i.test(line))).toBe(
      true,
    );
  } finally {
    await restarted.stop();
  }
});

test("a task interrupted again after two automatic resumes stops and says so once", async () => {
  const info = vi.spyOn(log, "logInfo");
  const root = await interruptedTask();
  const key = `D123:${root}`;
  await SessionStore.claimResume(dmOffice(), key, 2);
  await SessionStore.claimResume(dmOffice(), key, 2);

  const restarted = await restartSlack();
  try {
    await vi.waitFor(() =>
      expect(
        trace.some((line) => line.startsWith(`post:${root}:`) && /not continuing/i.test(line)),
      ).toBe(true),
    );
    expect(faux.state.callCount).toBe(0);
  } finally {
    await restarted.stop();
  }

  trace.length = 0;
  info.mockClear();
  const again = await restartSlack();
  try {
    await vi.waitFor(() =>
      expect(
        info.mock.calls.some((c) => String(c[0]).includes("Resumed 0 interrupted tasks")),
      ).toBe(true),
    );
    expect(trace.some((line) => line.startsWith(`post:${root}:`))).toBe(false);
  } finally {
    await again.stop();
  }
});

test("restart resumes only recent, unfinished tasks that recorded their start", async () => {
  const info = vi.spyOn(log, "logInfo");
  await interruptedTask({ ended: true });
  await interruptedTask({ legacy: true });
  await interruptedTask({ ageSeconds: 2 * DAY_SECONDS });
  const restarted = await restartSlack();
  try {
    await vi.waitFor(() =>
      expect(
        info.mock.calls.some((c) => String(c[0]).includes("Resumed 0 interrupted tasks")),
      ).toBe(true),
    );
    expect(faux.state.callCount).toBe(0);
  } finally {
    await restarted.stop();
  }
});

test("a finished task reports its answer to the requester's conversation without a signature", async () => {
  faux.setResponses([
    handoff(),
    callHold(),
    fauxAssistantMessage("finished result\n\n_Triggered by @u1_"),
  ]);
  await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  await vi.waitFor(async () => {
    const requester = await SessionStore.inspect(dmOffice(), "D123");
    const transcript = JSON.stringify((await requester!.buildSessionContext()).messages);
    expect(transcript).toContain("finished result");
    expect(transcript).toMatch(/background task .* finished/);
    expect(transcript).not.toContain("Triggered by");
  });
});

test("shutdown leaves a running task for the next process instead of waiting for it", async () => {
  faux.setResponses([handoff(), callHold()]);
  await startTask();
  const startedAt = Date.now();
  await bot.stop();
  await runtime.shutdown(60_000);
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(aborted).toBe(false);
  expect(trace).not.toContain("tool:end");
});

test("a task run is not offered the task tools", async () => {
  let taskTools: string[] = [];
  faux.setResponses([
    handoff(),
    (context) => {
      taskTools = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage("done");
    },
  ]);
  await dm("investigate this");
  await vi.waitFor(() => expect(taskTools.length).toBeGreaterThan(0));
  expect(taskTools).not.toContain("task_status");
  expect(taskTools).not.toContain("start_task");
});
