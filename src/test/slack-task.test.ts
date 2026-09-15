// Exercises actual Slack intake, runtime, Pi and session persistence with fake transport/model.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
import { createGlobalSettingsFile } from "../config.js";
import { MikanModels } from "../harness/index.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import { querySlackTasks, isTaskStatusQuestion } from "../adapters/slack/task-status.js";
import { SlackMessagingBot } from "../adapters/slack/bot.js";

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
    expect.stringContaining("這一輪已結束"),
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
