import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postLocallyDeliveredMessage,
  postMessage,
  summarizeMessage,
  waitForThreadBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack thread session isolation", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-020 thread sessions do not leak context into each other", async () => {
    const tokenA = `QA_ISOLATE_A_${Date.now()}`;
    const tokenB = `QA_ISOLATE_B_${Date.now()}`;
    const rootA = await postMessage(
      client,
      env.channel,
      `QA thread isolation root A ${new Date().toISOString()}`,
    );
    const rootB = await postMessage(
      client,
      env.channel,
      `QA thread isolation root B ${new Date().toISOString()}`,
    );

    const tellAStartedAt = nowSeconds();
    const { ts: tellATs, deliveryMarker: tellAMarker } = await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      threadTs: rootA,
      text: (deliveryMarker) =>
        `<@${botUserId}> 請記住這個 token：${tokenA}。` +
        `現在只需回覆 OK 並原樣附上 ${deliveryMarker}，不要重複 token。`,
      timeoutMs: Math.max(env.timeoutMs, 15_000),
      pollMs: env.pollMs,
    });
    const tellAReply = await waitForThreadBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs: rootA,
      startedAt: tellAStartedAt,
      excludeTs: new Set([rootA, tellATs]),
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: tellAMarker,
    });
    expect(tellAReply, "no reply in thread A after storing the token").not.toBeNull();

    const tellBStartedAt = nowSeconds();
    const { ts: tellBTs, deliveryMarker: tellBMarker } = await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      threadTs: rootB,
      text: (deliveryMarker) =>
        `<@${botUserId}> 請記住這個 token：${tokenB}。` +
        `現在只需回覆 OK 並原樣附上 ${deliveryMarker}，不要重複 token。`,
      timeoutMs: Math.max(env.timeoutMs, 15_000),
      pollMs: env.pollMs,
    });
    const tellBReply = await waitForThreadBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs: rootB,
      startedAt: tellBStartedAt,
      excludeTs: new Set([rootB, tellBTs]),
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: tellBMarker,
    });
    expect(tellBReply, "no reply in thread B after storing the token").not.toBeNull();

    const askAStartedAt = nowSeconds();
    const { ts: askATs } = await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      threadTs: rootA,
      text: () => `<@${botUserId}> 請只回覆我在這個 thread 要你記住的 token，不要加其他文字。`,
      timeoutMs: Math.max(env.timeoutMs, 15_000),
      pollMs: env.pollMs,
    });
    const askAReply = await waitForThreadBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs: rootA,
      startedAt: askAStartedAt,
      excludeTs: new Set([rootA, tellATs, String(tellAReply!.ts), askATs]),
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: tokenA,
    });
    expect(askAReply, `no thread A reply containing ${tokenA}`).not.toBeNull();
    expect(
      askAReply!.text ?? "",
      "thread A reply leaked thread B's token — sessions are not isolated",
    ).not.toContain(tokenB);
    console.log(`thread A recall ts=${askAReply!.ts}: ${summarizeMessage(askAReply!)}`);
  }, 240_000);
});
