import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { SlackMessagingBot } from "../../src/adapters/slack/bot.js";
import { createSlackAdapters } from "../../src/adapters/slack/context.js";
import { createOfficeAddress } from "../../src/office/index.js";
import { assertBotTokenShape } from "./helpers/env.js";
import { loadContextOrSkip } from "./helpers/client.js";
import { fetchThreadMessages, postMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

function createRealSlackResponderBot(botClient: WebClient): SlackMessagingBot {
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
    postInThread: (channel: string, threadTs: string, text: string) => {
      if (rejectNextPost) {
        rejectNextPost = false;
        const error = new Error("An API error occurred: msg_too_long") as Error & {
          data?: { error: string };
        };
        error.data = { error: "msg_too_long" };
        return Promise.reject(error);
      }
      // The receiver must inherit the real prototype (postInThread reaches
      // this.resolveMentions) and carry the fields it reads.
      const receiver = Object.assign(Object.create(SlackMessagingBot.prototype) as object, {
        webClient: botClient,
        users: new Map(),
      });
      return Reflect.apply(SlackMessagingBot.prototype.postInThread, receiver, [
        channel,
        threadTs,
        text,
      ]) as Promise<string>;
    },
    logBotResponse: () => undefined,
  } as unknown as SlackMessagingBot;
}

describe.skipIf(!ctx || !ctx.env.streamingBotToken)("Slack long-message continuation", () => {
  if (!ctx || !ctx.env.streamingBotToken) return;
  const { client, env } = ctx;
  assertBotTokenShape(env.streamingBotToken);
  const botClient = new WebClient(env.streamingBotToken);

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
          conversationId: env.channel,
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
          if (!message.ts || message.ts === rootTs) continue;
          await botClient.chat
            .delete({ channel: env.channel, ts: message.ts })
            .catch(() => client.chat.delete({ channel: env.channel, ts: message.ts }));
        }
        await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
      }
    }
  });
});
