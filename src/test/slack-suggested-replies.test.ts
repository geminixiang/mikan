import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, type MutableModels } from "@earendil-works/pi-ai";
import type { KnownBlock } from "@slack/types";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import {
  suggestedReplyOf,
  withTappedSuggestedReply,
  withSuggestedReplies,
} from "../adapters/slack/suggested-replies.js";
import type {
  SlackSocketConnection,
  SlackSocketEventArgs,
  SlackWebApi,
} from "../adapters/slack/types.js";
import { MikanModels } from "../harness/models.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { readOfficeLog } from "../office/log.js";
import type { Workspace } from "../office/types.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import { localRunnerFactory } from "./local-execution.js";
import { runtimeServices } from "./runtime-services.js";

const markdown = (text: string): KnownBlock => ({ type: "markdown", text });

describe("the suggested replies block", () => {
  test("is one actions block after the rendered text, with one button per suggestion", () => {
    const message = { text: "Draft.", blocks: [markdown("Draft.")] };

    expect(withSuggestedReplies(message, ["Make it shorter", "More formal"])).toEqual({
      text: "Draft.",
      blocks: [
        markdown("Draft."),
        {
          type: "actions",
          block_id: "suggested_replies",
          elements: [
            {
              type: "button",
              action_id: "suggested_reply_1",
              text: { type: "plain_text", text: "Make it shorter" },
              value: "Make it shorter",
            },
            {
              type: "button",
              action_id: "suggested_reply_2",
              text: { type: "plain_text", text: "More formal" },
              value: "More formal",
            },
          ],
        },
      ],
    });
  });

  test("shortens a label past Slack's 75 characters and keeps the whole line as the value", () => {
    const line = `${"長".repeat(74)}😀 and more`;

    const { blocks } = withSuggestedReplies({ blocks: [markdown("x")] }, [line, "a".repeat(75)]);

    const [long, exact] = (blocks[1] as { elements: { text: { text: string }; value: string }[] })
      .elements;
    expect(long?.text.text).toBe(`${"長".repeat(74)}…`);
    expect(long?.value).toBe(line);
    expect(exact?.text.text).toBe("a".repeat(75));
  });

  test("leaves out a line too long to send as a button value", () => {
    const message = { blocks: [markdown("x")] };

    expect(withSuggestedReplies(message, ["a".repeat(2001)])).toBe(message);
    expect(
      (withSuggestedReplies(message, ["a".repeat(2001), "ok"]).blocks[1] as { elements: object[] })
        .elements,
    ).toHaveLength(1);
  });

  test("gives way to the text when the message has no room for another block", () => {
    const full = { blocks: Array.from({ length: 50 }, (_, index) => markdown(`p${index}`)) };
    const headings = { blocks: [markdown(Array.from({ length: 50 }, () => "# h").join("\n\n"))] };

    expect(withSuggestedReplies(full, ["next"])).toBe(full);
    expect(withSuggestedReplies(headings, ["next"])).toBe(headings);
    expect(withSuggestedReplies({ blocks: full.blocks.slice(1) }, ["next"]).blocks).toHaveLength(
      50,
    );
  });

  test("is not added without suggestions", () => {
    const message = { blocks: [markdown("x")] };

    expect(withSuggestedReplies(message, undefined)).toBe(message);
    expect(withSuggestedReplies(message, [])).toBe(message);
  });

  test("is recognised by its buttons and replaced by who tapped which line", () => {
    const { blocks } = withSuggestedReplies({ blocks: [markdown("x")] }, ["next"]);

    expect(suggestedReplyOf({ action_id: "suggested_reply_1", value: "next" })).toBe("next");
    expect(suggestedReplyOf({ action_id: "button_1", value: "next" })).toBeUndefined();
    expect(suggestedReplyOf({ action_id: "suggested_reply_1" })).toBeUndefined();
    expect(withTappedSuggestedReply(blocks, { userId: "U1", text: "a <b> & c" })).toEqual([
      markdown("x"),
      {
        type: "context",
        block_id: "suggested_replies",
        elements: [{ type: "mrkdwn", text: "<@U1>: a &lt;b&gt; &amp; c" }],
      },
    ]);
  });
});

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

interface WriteBlock {
  type: string;
  text?: unknown;
  block_id?: string;
}

interface Write {
  ts?: string;
  text?: string;
  thread_ts?: string;
  blocks?: WriteBlock[];
}

const ok = async () => ({ ok: true });
const REPLY = "Here is the draft.\n\n↳ Make it shorter\n↳ More formal";
const SUGGESTIONS_BLOCK = {
  type: "actions",
  block_id: "suggested_replies",
  elements: [
    {
      type: "button",
      action_id: "suggested_reply_1",
      text: { type: "plain_text", text: "Make it shorter" },
      value: "Make it shorter",
    },
    {
      type: "button",
      action_id: "suggested_reply_2",
      text: { type: "plain_text", text: "More formal" },
      value: "More formal",
    },
  ],
};

describe("suggested replies on Slack", () => {
  let dir: string;
  let workspace: Workspace;
  let faux: ReturnType<typeof fauxProvider>;
  let runtime: ReturnType<typeof createConversationRuntime>;
  let bot: SlackMessagingBot;
  let socket: FakeSlackSocket;
  let writes: Write[];
  let rejectWrite: (write: Write) => boolean;
  let sequence = 0;

  const answerWrites = () =>
    writes.filter((write) => write.blocks?.some((block) => block.type === "markdown"));
  const idle = () =>
    vi.waitFor(() => expect(runtime.getRunningSessions()).toHaveLength(0), { timeout: 10_000 });
  const log = (channel: string) =>
    readOfficeLog(workspace.office(createOfficeAddress("slack", channel)));

  async function say(channel: string, text: string, thread?: string): Promise<void> {
    const calls = faux.state.callCount;
    await socket.deliver("message", {
      event: {
        text,
        channel,
        user: "U1",
        ts: `1700000001.${String(++sequence).padStart(6, "0")}`,
        thread_ts: thread,
        channel_type: "im",
      },
    });
    await vi.waitFor(() => expect(faux.state.callCount).toBeGreaterThan(calls), {
      timeout: 10_000,
    });
    await idle();
  }

  async function tap(target: Write, user: { id: string; username: string }): Promise<void> {
    const calls = faux.state.callCount;
    await socket.deliver("block_actions", {
      body: {
        type: "block_actions",
        user,
        container: { channel_id: "D123", message_ts: target.ts, thread_ts: target.thread_ts },
        message: { ts: target.ts, text: target.text, blocks: target.blocks },
        actions: [
          {
            type: "button",
            block_id: "suggested_replies",
            action_id: "suggested_reply_1",
            value: "Make it shorter",
          },
        ],
      },
    });
    await vi.waitFor(() => expect(faux.state.callCount).toBeGreaterThan(calls), {
      timeout: 10_000,
    });
    await idle();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mikan-suggested-replies-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    createGlobalSettingsFile(stateDir);
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
    );
    workspace = createWorkspace({ root: dir, stateDir });
    const models = MikanModels.create({ modelsJsonPath: join(stateDir, "models.json") });
    faux = fauxProvider();
    (models.models as MutableModels).setProvider(faux.provider);
    writes = [];
    rejectWrite = () => false;
    const record = (write: Write, ts: string) => {
      if (rejectWrite(write)) {
        throw Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } });
      }
      writes.push({ ...write, ts });
      return { ok: true, ts };
    };
    const webApi: SlackWebApi = {
      auth: { test: async () => ({ ok: true, user_id: "BOT" }) },
      chat: {
        postMessage: async (args) =>
          record(args, `1700000002.${String(++sequence).padStart(6, "0")}`),
        postEphemeral: ok,
        update: async (args) => record(args, args.ts),
        delete: ok,
      },
      conversations: {
        open: ok,
        history: async () => ({ ok: true, messages: [] }),
        replies: async () => ({ ok: true, messages: [] }),
        list: async () => ({ ok: true, channels: [] }),
      },
      users: {
        list: async () => ({
          ok: true,
          members: [
            { id: "U1", name: "alice" },
            { id: "U2", name: "bob" },
          ],
        }),
      },
      reactions: { add: ok },
      files: { uploadV2: async () => ({ ok: true, files: [] }) },
      apiCall: ok,
    };
    runtime = createConversationRuntime({
      workspace,
      models,
      ...runtimeServices(stateDir),
      runnerFactory: localRunnerFactory,
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
    vi.spyOn(bot, "setAssistantStatus").mockResolvedValue(undefined);
    vi.spyOn(bot, "tryReserveStreamStart").mockReturnValue(false);
  });

  afterEach(async () => {
    await bot.stop();
    await runtime.shutdown();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the final reply drops the marked lines and carries them as buttons", async () => {
    faux.setResponses([fauxAssistantMessage(REPLY)]);

    await say("D123", "draft a leave email");

    expect(answerWrites().at(-1)?.blocks).toEqual([
      { type: "markdown", text: "Here is the draft.\n\n_Triggered by @alice_" },
      SUGGESTIONS_BLOCK,
    ]);
    expect(log("D123").findLast((entry) => entry.isMessagingBot)).toMatchObject({
      text: "Here is the draft.\n\n_Triggered by @alice_",
      suggestions: ["Make it shorter", "More formal"],
    });
  });

  test("a reply without marked lines is sent and logged as before", async () => {
    faux.setResponses([fauxAssistantMessage("Paris.")]);

    await say("D123", "capital of France?");

    expect(answerWrites().at(-1)?.blocks).toEqual([
      { type: "markdown", text: "Paris.\n\n_Triggered by @alice_" },
    ]);
    expect(log("D123").findLast((entry) => entry.isMessagingBot)).not.toHaveProperty("suggestions");
  });

  test("a tap becomes that person's message and the buttons become a line saying who tapped what", async () => {
    let seen = "";
    faux.setResponses([
      fauxAssistantMessage(REPLY),
      (context) => {
        seen = JSON.stringify(context.messages.findLast((message) => message.role === "user"));
        return fauxAssistantMessage("Shorter draft.");
      },
    ]);
    await say("D123", "draft a leave email");
    const reply = answerWrites().at(-1)!;

    await tap(reply, { id: "U2", username: "bob" });

    expect(seen).toContain("[bob]: Make it shorter");
    expect(seen).not.toContain("[Slack action]");
    expect(log("D123").findLast((entry) => !entry.isMessagingBot)).toMatchObject({
      user: "U2",
      userName: "bob",
      text: "Make it shorter",
      slackInteraction: { actionId: "suggested_reply_1", messageTs: reply.ts },
    });
    const afterTap = writes.findLast((write) => write.ts === reply.ts);
    expect(afterTap).not.toBe(reply);
    expect(afterTap).toMatchObject({
      text: reply.text,
      blocks: [
        { type: "markdown", text: "Here is the draft.\n\n_Triggered by @alice_" },
        {
          type: "context",
          block_id: "suggested_replies",
          elements: [{ type: "mrkdwn", text: "<@U2>: Make it shorter" }],
        },
      ],
    });
    expect(JSON.stringify(answerWrites().at(-1)?.blocks)).toContain("Shorter draft.");
  });

  test("the reply and a tapped line are in the session once on later turns", async () => {
    let context = "";
    faux.setResponses([
      fauxAssistantMessage(REPLY),
      fauxAssistantMessage("Shorter draft."),
      (seen) => {
        context = JSON.stringify(seen.messages);
        return fauxAssistantMessage("Done.");
      },
    ]);
    await say("D123", "draft a leave email");
    await tap(answerWrites().at(-1)!, { id: "U1", username: "alice" });

    await say("D123", "thanks, send it");

    expect(context.split("Here is the draft.")).toHaveLength(2);
    expect(context.split("Make it shorter")).toHaveLength(3);
    expect(context.split("Shorter draft.")).toHaveLength(2);
    expect(context).toContain("[alice]: Make it shorter");
  });

  test("a tap still starts the run when Slack refuses to remove the buttons", async () => {
    faux.setResponses([fauxAssistantMessage(REPLY), fauxAssistantMessage("Shorter draft.")]);
    await say("D123", "draft a leave email");
    const reply = answerWrites().at(-1)!;
    rejectWrite = (write) => write.ts === reply.ts;

    await tap(reply, { id: "U1", username: "alice" });

    expect(JSON.stringify(answerWrites().at(-1)?.blocks)).toContain("Shorter draft.");
  });

  test("the reply is sent without buttons when Slack rejects it with them", async () => {
    faux.setResponses([fauxAssistantMessage(REPLY)]);
    rejectWrite = (write) => write.blocks?.some((block) => block.type === "actions") === true;

    await say("D123", "draft a leave email");

    expect(answerWrites().at(-1)?.blocks).toEqual([
      { type: "markdown", text: "Here is the draft.\n\n_Triggered by @alice_" },
    ]);
    expect(log("D123").findLast((entry) => entry.isMessagingBot)).not.toHaveProperty("suggestions");
  });
});
