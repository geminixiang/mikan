import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { assertBotTokenShape } from "./helpers/env.js";
import {
  nowSeconds,
  postMessage,
  waitForBotReply,
  waitForRecentBotReply,
  waitForThreadBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.streamingBotToken)("Slack wait helpers", () => {
  if (!ctx || !ctx.env.streamingBotToken) return;
  const { client, env } = ctx;
  assertBotTokenShape(env.streamingBotToken);
  const botClient = new WebClient(env.streamingBotToken);

  it("S-014 waits for bot replies in recent messages and threads", async () => {
    const botAuth = await botClient.auth.test();
    const botUserId = String(botAuth.user_id ?? "");
    expect(botUserId).not.toBe("");

    const token = `QA_WAIT_${Date.now()}`;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, env.channel, `QA wait helper root ${token}`);
    const threadBotTs = await postMessage(botClient, env.channel, `${token}_THREAD`, rootTs);
    const topLevelBotTs = await postMessage(botClient, env.channel, `${token}_RECENT`);

    try {
      const threaded = await waitForBotReply({
        client,
        channel: env.channel,
        botUserId,
        rootTs,
        startedAt,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textIncludes: `${token}_THREAD`,
      });
      expect(threaded?.ts).toBe(threadBotTs);

      const threadOnly = await waitForThreadBotReply({
        client,
        channel: env.channel,
        botUserId,
        rootTs,
        startedAt,
        excludeTs: new Set([rootTs]),
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textMatches: new RegExp(`${token}_THREAD`),
      });
      expect(threadOnly?.ts).toBe(threadBotTs);

      const recent = await waitForRecentBotReply({
        client,
        channel: env.channel,
        botUserId,
        startedAt,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textIncludes: `${token}_RECENT`,
      });
      expect(recent?.ts).toBe(topLevelBotTs);
    } finally {
      await botClient.chat.delete({ channel: env.channel, ts: threadBotTs }).catch(() => undefined);
      await botClient.chat
        .delete({ channel: env.channel, ts: topLevelBotTs })
        .catch(() => undefined);
      await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
    }
  });
});
