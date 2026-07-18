import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  openDmChannel,
  postMessage,
  summarizeMessage,
  waitForBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack DM", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-017 mikan replies to a DM without mention", async () => {
    const dmChannel = await openDmChannel(client, botUserId);
    const token = `QA_DM_${Date.now()}`;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, dmChannel, `DM e2e：請直接回覆這個 token：${token}`);
    const reply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    expect(reply, `no DM reply containing ${token}`).not.toBeNull();
    console.log(`dm reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });

  it("S-018 DM session retains multi-turn context", async () => {
    const dmChannel = await openDmChannel(client, botUserId);
    const token = `QA_DM_CTX_${Date.now()}`;
    const firstStartedAt = nowSeconds();
    const firstTs = await postMessage(
      client,
      dmChannel,
      `請記住這個 token：${token}。現在只需回覆 OK，不要重複 token。`,
    );
    const firstReply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs: firstTs,
      startedAt: firstStartedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
    });
    expect(firstReply, "no reply to the first DM turn").not.toBeNull();

    const followupStartedAt = nowSeconds();
    const followupTs = await postMessage(
      client,
      dmChannel,
      "請只回覆我上一則訊息要你記住的 token，不要加其他文字。",
    );
    const reply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs: followupTs,
      startedAt: followupStartedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    expect(reply, `no context-carrying DM reply containing ${token}`).not.toBeNull();
    console.log(`dm context reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  }, 180_000);
});
