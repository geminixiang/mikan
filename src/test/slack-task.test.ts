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
import { Type } from "@sinclair/typebox";
import { type AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { createWorkspace, createOfficeAddress } from "../office/index.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { JevNotConfiguredError } from "../harness/jev.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import * as observability from "../observability/index.js";
import {
  querySlackTasks,
  isTaskStatusQuestion,
  readTaskRoots,
} from "../adapters/slack/task-status.js";
import { SlackMessagingBot } from "../adapters/slack/bot.js";

const jev = vi.fn();
vi.mock("../harness/jev.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/jev.js")>();
  return { ...actual, evaluateWithJev: (...args: unknown[]) => jev(...args) };
});
const jevChoice = (choice: string) =>
  jev.mockResolvedValueOnce({ answers: { intent: { type: "choice", choice } } });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let dir: string;
let envBefore: string | undefined;
let models: MikanModels;
let faux: ReturnType<typeof fauxProvider>;
let workspace: ReturnType<typeof createWorkspace>;
let runtime: ReturnType<typeof createConversationRuntime>;
let bot: SlackMessagingBot;
let internals: any;
let hold: ReturnType<typeof deferred>;
let started: ReturnType<typeof deferred>;
let aborted: boolean;
let trace: string[];
let id: number;
const address = createOfficeAddress("slack", "C123");
const eventTs = () => `${Math.floor(Date.now() / 1000)}.${String(++id).padStart(6, "0")}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-task-simulation-"));
  envBefore = process.env.MIKAN_STATE_DIR;
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  process.env.MIKAN_STATE_DIR = stateDir;
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
  const tool: AgentTool = {
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
  bot = new SlackMessagingBot(runtime, { appToken: "test", botToken: "test", workspace });
  internals = bot;
  internals.startupTs = "0";
  internals.botUserId = "BOT";
  internals.socketClient = { disconnect: vi.fn().mockResolvedValue(undefined) };
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
  if (envBefore === undefined) delete process.env.MIKAN_STATE_DIR;
  else process.env.MIKAN_STATE_DIR = envBefore;
  rmSync(dir, { recursive: true, force: true });
});
const callHold = () => fauxAssistantMessage(fauxToolCall("hold", {}));

async function dm(text: string, thread_ts?: string) {
  await internals.handleMessageEvent({
    event: { text, channel: "D123", user: "U1", ts: eventTs(), thread_ts, channel_type: "im" },
    ack() {},
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
  await internals.handleAppMention({
    event: { text: "<@BOT> wait", channel: "C123", user: "U1", ts: eventTs(), thread_ts: "100.1" },
    ack() {},
  });
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  await internals.handleMessageEvent({
    event: {
      text: "stop",
      channel: "C123",
      user: "U1",
      ts: eventTs(),
      thread_ts: "100.1",
      channel_type: "channel",
    },
    ack() {},
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

test("main DM task_status reads live work and persisted completion without reopening writer", async () => {
  let observed = "";
  faux.setResponses([
    handoff(),
    callHold(),
    fauxAssistantMessage(fauxToolCall("task_status", {})),
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
  const result = await querySlackTasks(office.dir, "D123", [], `D123:${root}`);
  expect(result[0].status).toBe("completed");
  expect(result[0].endedAt).toBeDefined();
  expect(await querySlackTasks(office.dir, "D123", [], "OTHER:123")).toEqual([]);
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
  const original = MikanAgentSession.prototype.reloadFromSession;
  vi.spyOn(MikanAgentSession.prototype, "reloadFromSession").mockImplementationOnce(
    async function () {
      preparing.resolve();
      await release.promise;
      return original.call(this);
    },
  );
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
  const original = MikanAgentSession.prototype.reloadFromSession;
  const spy = vi
    .spyOn(MikanAgentSession.prototype, "reloadFromSession")
    .mockImplementation(async function (this: MikanAgentSession) {
      if (readTaskRoots(office.dir).size) {
        preparing.resolve();
        await release.promise;
      }
      return original.call(this);
    });
  await dm("investigate this");
  await preparing.promise;
  const root = [...readTaskRoots(office.dir).keys()][0]!;
  const before = await querySlackTasks(office.dir, "D123", [], `D123:${root}`);
  expect(before[0]?.status).toBe("queued");
  spy.mockRestore();
  release.resolve();
  await vi.waitFor(() => expect(trace).toContain("tool:start"));
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const after = await querySlackTasks(office.dir, "D123", [], `D123:${root}`);
  expect(after[0]?.status).toBe("completed");
});

test("recent status listing keeps an older active task even with ten newer task roots", async () => {
  faux.setResponses([handoff(), callHold()]);
  const root = await startTask();
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  for (let i = 0; i < 11; i++)
    appendFileSync(
      office.logPath,
      JSON.stringify({
        ts: `9999999999.${i}`,
        taskRoot: true,
        isMessagingBot: true,
        text: `later ${i}`,
      }) + "\n",
    );
  const observations = await querySlackTasks(office.dir, "D123", runtime.getRunningSessions());
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

test("task membership parser tolerates malformed logs and status isolates platform identity", async () => {
  faux.setResponses([handoff(), callHold(), fauxAssistantMessage("done")]);
  const root = await startTask();
  hold.resolve();
  await vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0));
  const office = workspace.office(createOfficeAddress("slack", "D123"));
  appendFileSync(office.logPath, "not-json\nnull\n");
  const observations = await querySlackTasks(
    office.dir,
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
  expect(observations[0].status).toBe("completed");
  expect(observations[0].currentTool).toBeUndefined();
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
