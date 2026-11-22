import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import { createSlackToolPack } from "../adapters/slack/tool-pack.js";
import type {
  SlackSocketConnection,
  SlackSocketEventArgs,
  SlackWebApi,
} from "../adapters/slack/types.js";
import { MikanModels } from "../harness/models.js";
import { createWorkspace } from "../office/index.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import { localRunnerFactory } from "./local-execution.js";
import { runtimeServices } from "./runtime-services.js";

class FakeSlackSocket implements SlackSocketConnection {
  private readonly listeners = new Map<string, Array<(args: SlackSocketEventArgs) => unknown>>();

  on(event: string, listener: (args: SlackSocketEventArgs) => unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async start(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async deliver(event: string, args: Partial<SlackSocketEventArgs>): Promise<void> {
    const full: SlackSocketEventArgs = { ack: async () => {}, ...args };
    await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(full)));
  }
}

const ok = async () => ({ ok: true });
const POSTED_TS = "1700000000.000100";

let dir: string;
let faux: ReturnType<typeof fauxProvider>;
let runtime: ReturnType<typeof createConversationRuntime>;
let bot: SlackMessagingBot;
let socket: FakeSlackSocket;
let posted: Array<{ blocks?: unknown; thread_ts?: string }>;
let updated: Array<{ ts: string; text?: string; blocks?: unknown }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mikan-blockkit-roundtrip-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir);
  createGlobalSettingsFile(stateDir);
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
  );
  const workspace = createWorkspace({ root: dir, stateDir });
  const models = MikanModels.create({ modelsJsonPath: join(stateDir, "models.json") });
  faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  posted = [];
  updated = [];
  const webApi: SlackWebApi = {
    auth: { test: async () => ({ ok: true, user_id: "BOT" }) },
    chat: {
      postMessage: async (args) => {
        posted.push(args);
        return { ok: true, ts: POSTED_TS };
      },
      postEphemeral: ok,
      update: async (args) => {
        updated.push(args);
        return { ok: true };
      },
      delete: ok,
    },
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
  runtime = createConversationRuntime({
    workspace,
    models,
    ...runtimeServices(stateDir),
    runnerFactory: localRunnerFactory,
    platformToolPackFactories: [
      () =>
        createSlackToolPack({
          postBlocks: async (conversationId, { text, blocks, threadTs }) => {
            const ts = await bot.postMessageBlocks(conversationId, text, blocks, threadTs);
            bot.logBotResponse(conversationId, text, ts, threadTs, { slackBlocks: blocks });
            return { ts };
          },
          updateBlocks: async (conversationId, { ts, text, blocks, threadTs }) => {
            await bot.updateMessageBlocks(conversationId, ts, text, blocks);
            bot.logBotResponse(conversationId, text, ts, threadTs, { slackBlocks: blocks });
          },
          ownsBlockKitMessage: (conversationId, ts, threadTs) =>
            bot.ownsBlockKitMessage(conversationId, ts, threadTs),
          resolveMentions: (text) => bot.resolveMentions(text),
        }),
    ],
  });
  socket = new FakeSlackSocket();
  bot = new SlackMessagingBot(runtime, {
    appToken: "test",
    botToken: "test",
    workspace,
    webApi,
    socket,
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await bot.start();
  } finally {
    now.mockRestore();
  }
  vi.spyOn(bot, "postMessage").mockResolvedValue("1700000000.000200");
  vi.spyOn(bot, "updateMessage").mockResolvedValue(undefined);
  vi.spyOn(bot, "setAssistantStatus").mockResolvedValue(undefined);
  vi.spyOn(bot, "tryReserveStreamStart").mockReturnValue(false);
});

afterEach(async () => {
  await bot.stop();
  await runtime.shutdown();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const idle = () =>
  vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0), { timeout: 10_000 });

test("buttons reach Slack, a click reaches the agent, and the agent replaces the message", async () => {
  let clickSeen = "";
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("slack_blockkit", {
        label: "Ask",
        text: "Deploy **v2**?",
        buttons: [
          { text: "Approve", value: "yes", style: "primary" },
          { text: "Reject", value: "no" },
        ],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("asked"),
    (context) => {
      clickSeen = JSON.stringify(context.messages.findLast((message) => message.role === "user"));
      return fauxAssistantMessage(
        fauxToolCall("slack_blockkit", {
          label: "Close",
          text: "Approved.",
          buttons: [],
          update_ts: POSTED_TS,
        }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("closed"),
  ]);

  await socket.deliver("message", {
    event: {
      text: "ask me",
      channel: "D123",
      user: "U1",
      ts: "1700000000.000001",
      channel_type: "im",
    },
  });
  await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 10_000 });
  await idle();
  expect(posted[0]?.blocks).toEqual([
    { type: "markdown", text: "Deploy **v2**?" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "button_1",
          text: { type: "plain_text", text: "Approve" },
          value: "yes",
          style: "primary",
        },
        {
          type: "button",
          action_id: "button_2",
          text: { type: "plain_text", text: "Reject" },
          value: "no",
        },
      ],
    },
  ]);

  await socket.deliver("block_actions", {
    body: {
      type: "block_actions",
      user: { id: "U1", username: "alice" },
      container: { channel_id: "D123", message_ts: POSTED_TS },
      actions: [{ type: "button", action_id: "button_1", value: "yes" }],
    },
  });
  await vi.waitFor(() => expect(updated).toHaveLength(1), { timeout: 10_000 });
  await idle();

  expect(clickSeen).toContain("[Slack action] button_1: yes");
  expect(updated[0]).toMatchObject({
    ts: POSTED_TS,
    blocks: [{ type: "markdown", text: "Approved." }],
  });
});
