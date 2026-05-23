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

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack stop", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-008 mikan acknowledges stop", async () => {
    const startedAt = nowSeconds();
    await postMessage(
      client,
      env.channel,
      `<@${botUserId}> e2e stop 測試：請使用 bash 執行 sleep 60，在等待期間不要先回覆完成。`,
    );
    await sleep(Math.min(8_000, Math.max(2_000, env.pollMs * 2)));
    await postMessage(client, env.channel, `<@${botUserId}> stop`);
    const reply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textMatches: /Stopped|Nothing running|Force stopped|Stopping/i,
    });
    expect(reply, "no stop acknowledgement from mikan").not.toBeNull();
    console.log(`stop reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });
});
