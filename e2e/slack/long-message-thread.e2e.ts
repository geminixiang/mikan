import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { SlackMessagingBot } from "../../src/adapters/slack/bot.js";
import { createSlackAdapters } from "../../src/adapters/slack/context.js";
import type { SlackResponderBot } from "../../src/adapters/slack/types.js";
import { createOfficeAddress, createWorkspace } from "../../src/office/index.js";
import type { MessagingEventHandler } from "../../src/types.js";
import { assertBotTokenShape } from "./helpers/env.js";
import { loadContextOrSkip } from "./helpers/client.js";
import { fetchThreadMessages, postMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

const unusedHandler: MessagingEventHandler = {
  isRunning: () => false,
  getRunningSessions: () => [],
  handleEvent: async () => {},
  handleStop: async () => {},
  forceStop: () => {},
  handleNewCommand: async () => {},
};

const unused = () => Promise.reject(new Error("not used by the long-message E2E"));

function createRealSlackResponderBot(botClient: WebClient): SlackResponderBot {
  const stateDir = join(tmpdir(), "mikan-slack-long-message-e2e");
  const realBot = new SlackMessagingBot(unusedHandler, {
    appToken: "xapp-unused",
    botToken: "xoxb-unused",
    workspace: createWorkspace({ root: stateDir, stateDir }),
    webApi: botClient,
  });
  let rejectNextPost = true;
  return {
    getUser: () => undefined,
    getMessagingInfo: () => ({
      name: "slack",
      trustModel: "membership",
      formattingGuide: "",
      channels: [],
      users: [],
    }),
    tryReserveStreamStart: () => false,
    postInThread: (channel: string, threadTs: string, text: string) => {
      if (rejectNextPost) {
        rejectNextPost = false;
        const error = new Error("An API error occurred: msg_too_long") as Error & {
          data?: { error: string };
        };
        error.data = { error: "msg_too_long" };
        return Promise.reject(error);
      }
      return realBot.postInThread(channel, threadTs, text);
    },
    logBotResponse: () => undefined,
    postMessage: unused,
    postInThreadBlocks: unused,
    updateMessage: unused,
    deleteMessage: unused,
    startMessageStream: unused,
    appendMessageStream: unused,
    stopMessageStream: unused,
    uploadFile: unused,
    addReaction: unused,
    setAssistantStatus: unused,
  };
}

describe.skipIf(!ctx || !ctx.env.streamingBotToken)("Slack long-message continuation", () => {
  if (!ctx || !ctx.env.streamingBotToken) return;
  const { client, env } = ctx;
  const streamingBotToken = ctx.env.streamingBotToken;
  assertBotTokenShape(streamingBotToken);
  const botClient = new WebClient(streamingBotToken);

  it("S-024 keeps msg_too_long continuation messages in the existing thread", async () => {
    const token = `LONG_THREAD_E2E_${Date.now()}`;
    const longText = `${"x".repeat(6_000)}${token}`;
    let rootTs: string | undefined;

    try {
      rootTs = await postMessage(client, env.channel, `Slack long-message E2E root ${token}`);
      const userReplyTs = await postMessage(client, env.channel, "trigger", rootTs);
      const slack = createRealSlackResponderBot(botClient);
      const { responder } = createSlackAdapters(
        {
          type: "mention",
          address: createOfficeAddress("slack", env.channel),
          conversationKind: "shared",
          channel: env.channel,
          ts: userReplyTs,
          thread_ts: rootTs,
          user: "slack-e2e",
          text: "trigger",
        },
        slack,
      );

      await responder.replaceResponse(longText);

      const messages = await fetchThreadMessages(client, env.channel, rootTs);
      const fallback = messages.find((message) =>
        message.text?.includes("message too long for Slack; continued in thread"),
      );
      const continuation = messages.find((message) => message.text?.includes(token));
      expect(fallback, "missing msg_too_long fallback message").toBeDefined();
      expect(continuation, "missing long-message continuation").toBeDefined();
      expect(fallback!.thread_ts).toBe(rootTs);
      expect(continuation!.thread_ts).toBe(rootTs);
    } finally {
      if (rootTs) {
        const messages = await fetchThreadMessages(client, env.channel, rootTs).catch(() => []);
        for (const message of messages.toReversed()) {
          const messageTs = message.ts;
          if (!messageTs || messageTs === rootTs) continue;
          await botClient.chat
            .delete({ channel: env.channel, ts: messageTs })
            .catch(() => client.chat.delete({ channel: env.channel, ts: messageTs }));
        }
        await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
      }
    }
  });
});
