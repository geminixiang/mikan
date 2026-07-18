import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postMessage,
  sleep,
  summarizeMessage,
  waitForBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack busy queue", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-023 message sent while mikan is busy is queued and answered", async () => {
    const busyToken = `QA_BUSY_${Date.now()}`;
    const queuedToken = `QA_QUEUED_${Date.now()}`;
    const startedAt = nowSeconds();
    const busyRootTs = await postMessage(
      client,
      env.channel,
      `<@${botUserId}> busy-queue e2e：請使用 bash 執行 sleep 10，完成後回覆這個 token：${busyToken}`,
    );
    await sleep(2_000);
    const queuedRootTs = await postMessage(
      client,
      env.channel,
      `<@${botUserId}> 排隊測試：請直接回覆這個 token：${queuedToken}`,
    );

    const busyReply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs: busyRootTs,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 90_000),
      pollMs: env.pollMs,
      textIncludes: busyToken,
    });
    expect(busyReply, `no reply to the busy task containing ${busyToken}`).not.toBeNull();

    const queuedReply = await waitForBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs: queuedRootTs,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 90_000),
      pollMs: env.pollMs,
      textIncludes: queuedToken,
    });
    expect(queuedReply, `no reply to the queued message containing ${queuedToken}`).not.toBeNull();
    console.log(`busy reply ts=${busyReply!.ts}: ${summarizeMessage(busyReply!)}`);
    console.log(`queued reply ts=${queuedReply!.ts}: ${summarizeMessage(queuedReply!)}`);
  }, 240_000);
});
