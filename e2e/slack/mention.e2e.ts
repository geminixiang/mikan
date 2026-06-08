import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { nowSeconds, postMessage, summarizeMessage, waitForBotReply } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx)("Slack mention", () => {
  if (!ctx) return;
  const { client, env } = ctx;

  it.skipIf(!env.mikanBotUserId)("S-004 mikan replies to mention", async () => {
    const botUserId = env.mikanBotUserId;
    if (!botUserId) return;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, env.channel, `<@${botUserId}> ${env.mikanText}`);
    const reply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs,
      startedAt,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });
    expect(reply, "no reply from mikan").not.toBeNull();
    console.log(`mikan reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });
});
