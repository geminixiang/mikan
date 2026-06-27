import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { assertBotTokenShape } from "./helpers/env.js";
import { loadContextOrSkip } from "./helpers/client.js";
import { assertNoBotReplyToRoot, postMessage, summarizeMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId || !ctx.env.streamingBotToken)(
  "Slack bot-originated mention",
  () => {
    if (!ctx || !ctx.env.mikanBotUserId || !ctx.env.streamingBotToken) return;
    const { client, env } = ctx;
    assertBotTokenShape(env.streamingBotToken);
    const botClient = new WebClient(env.streamingBotToken);
    const botUserIds = [ctx.env.mikanBotUserId];

    it("S-012 bot-originated mentions do not trigger mikan", async () => {
      const rootTs = await postMessage(
        botClient,
        env.channel,
        `<@${ctx.env.mikanBotUserId}> QA bot-originated mention ${new Date().toISOString()}`,
      );
      const unexpected = await assertNoBotReplyToRoot({
        client,
        channel: env.channel,
        rootTs,
        botUserIds,
        timeoutMs: Math.min(env.timeoutMs, 10_000),
        pollMs: env.pollMs,
      });
      expect(
        unexpected,
        unexpected
          ? `unexpected bot reply from ${unexpected.user ?? unexpected.bot_id}: ${summarizeMessage(unexpected)}`
          : "",
      ).toBeNull();
    });
  },
);
