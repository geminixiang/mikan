import { beforeAll, describe, expect, it } from "vitest";
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

  // mikan ignores DMs from bots by design (loop protection), so these
  // scenarios only make sense when the QA token belongs to a human user.
  // Fail fast with the misconfiguration instead of timing out on a reply
  // that can never come.
  beforeAll(async () => {
    const auth = await client.auth.test();
    if (typeof auth.bot_id === "string" && auth.bot_id.length > 0) {
      throw new Error(
        `SLACK_QA_USER_TOKEN authenticates as bot ${auth.bot_id} (${String(auth.user)}). ` +
          "DM scenarios need a human User OAuth Token (xoxp-, auth.test without bot_id); " +
          "mikan deliberately does not reply to DMs from bots.",
      );
    }
  });

  it("S-017 mikan replies to a DM without mention", async () => {
    const dmChannel = await openDmChannel(client, botUserId);
    const token = `QA_DM_${Date.now()}`;
    const startedAt = nowSeconds();
    const rootTs = await postMessage(client, dmChannel, `DM e2e：請直接回覆這個 token：${token}`);
    let reply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    if (!reply) {
      // Budget models occasionally reply without the token; one
      // conversational repair keeps the assertion strict without flaking.
      const retryTs = await postMessage(
        client,
        dmChannel,
        `你剛才的回覆沒有包含 token。請重新回覆，務必原樣包含 token ${token}`,
      );
      reply = await waitForBotReply({
        client,
        channel: dmChannel,
        botUserId,
        rootTs: retryTs,
        startedAt,
        timeoutMs: Math.max(env.timeoutMs, 45_000),
        pollMs: env.pollMs,
        textIncludes: token,
      });
    }
    expect(reply, `no DM reply containing ${token}`).not.toBeNull();
    console.log(`dm reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  }, 180_000);

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
