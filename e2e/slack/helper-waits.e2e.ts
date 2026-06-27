import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { assertBotTokenShape } from "./helpers/env.js";
import {
  assertNoAdditionalBotReply,
  assertNoBotReplyToRoot,
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

  it("S-015 detects unexpected bot replies", async () => {
    const botAuth = await botClient.auth.test();
    const botUserId = String(botAuth.user_id ?? "");
    const botId = typeof botAuth.bot_id === "string" ? botAuth.bot_id : undefined;
    expect(botUserId).not.toBe("");

    const token = `QA_ASSERT_${Date.now()}`;
    const botUserIds = botId ? [botId, botUserId] : [botUserId];
    const rootTs = await postMessage(client, env.channel, `QA assert helper root ${token}`);
    const rootBotTs = await postMessage(botClient, env.channel, `${token}_ROOT`, rootTs);
    let secondRootTs: string | undefined;
    let markerTs: string | undefined;
    let additionalBotTs: string | undefined;

    try {
      const rootUnexpected = await assertNoBotReplyToRoot({
        client,
        channel: env.channel,
        rootTs,
        botUserIds,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
      });
      expect(rootUnexpected?.ts).toBe(rootBotTs);

      secondRootTs = await postMessage(client, env.channel, `QA assert additional root ${token}`);
      markerTs = await postMessage(client, env.channel, `${token}_MARKER`, secondRootTs);
      additionalBotTs = await postMessage(
        botClient,
        env.channel,
        `${token}_ADDITIONAL`,
        secondRootTs,
      );

      const additional = await assertNoAdditionalBotReply({
        client,
        channel: env.channel,
        rootTs: secondRootTs,
        botUserIds,
        afterTs: markerTs,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
      });
      expect(additional?.ts).toBe(additionalBotTs);
    } finally {
      await botClient.chat.delete({ channel: env.channel, ts: rootBotTs }).catch(() => undefined);
      if (additionalBotTs) {
        await botClient.chat
          .delete({ channel: env.channel, ts: additionalBotTs })
          .catch(() => undefined);
      }
      if (markerTs)
        await client.chat.delete({ channel: env.channel, ts: markerTs }).catch(() => undefined);
      await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
      if (secondRootTs) {
        await client.chat.delete({ channel: env.channel, ts: secondRootTs }).catch(() => undefined);
      }
    }
  });

  it("S-016 returns null when no matching bot reply appears", async () => {
    const botAuth = await botClient.auth.test();
    const botUserId = String(botAuth.user_id ?? "");
    expect(botUserId).not.toBe("");

    const token = `QA_MISSING_${Date.now()}`;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, env.channel, `QA missing helper root ${token}`);

    try {
      await expect(
        waitForBotReply({
          client,
          channel: env.channel,
          botUserId,
          rootTs,
          startedAt,
          timeoutMs: 1_000,
          pollMs: 1,
          textIncludes: `${token}_BOT`,
        }),
      ).resolves.toBeNull();

      await expect(
        waitForThreadBotReply({
          client,
          channel: env.channel,
          botUserId,
          rootTs,
          startedAt,
          excludeTs: new Set([rootTs]),
          timeoutMs: 1_000,
          pollMs: 1,
          textIncludes: `${token}_THREAD`,
        }),
      ).resolves.toBeNull();

      await expect(
        waitForRecentBotReply({
          client,
          channel: env.channel,
          botUserId,
          startedAt,
          timeoutMs: 1_000,
          pollMs: 1,
          textMatches: new RegExp(`${token}_RECENT`),
        }),
      ).resolves.toBeNull();
    } finally {
      await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
    }
  });
});
