import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postMessage,
  sleep,
  summarizeMessage,
  waitForRecentBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack stop while idle", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-019 addressed stop with nothing running reports idle", async () => {
    // First stop clears anything a previous scenario may have left running,
    // so the second stop deterministically hits the idle path.
    const startedAt = nowSeconds();
    const firstTs = await postMessage(client, env.channel, `<@${botUserId}> stop`);
    const firstAck = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      afterTs: firstTs,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textMatches: /Stopped|Stopping|Nothing running|Force stopped/i,
    });
    expect(firstAck, "no acknowledgement for the first stop").not.toBeNull();
    await sleep(Math.max(env.pollMs, 3_000));

    const secondTs = await postMessage(client, env.channel, `<@${botUserId}> stop`);
    const idleReply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      afterTs: secondTs,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textMatches: /Nothing running/i,
    });
    expect(idleReply, "no 'Nothing running' reply to an idle stop").not.toBeNull();
    console.log(`idle stop reply ts=${idleReply!.ts}: ${summarizeMessage(idleReply!)}`);
  }, 180_000);
});
