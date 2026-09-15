import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postLocallyDeliveredMessage,
  summarizeMessage,
  waitForRecentBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack one-shot event", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-011 one-shot event scheduled through the event tool triggers a reply with token", async () => {
    const token = `QA_EVENT_${Date.now()}`;
    const startedAt = nowSeconds();

    // Events are host-only office state now; the agent's event tool is the only
    // way a conversation schedules one, so the test asks for it like a user would.
    const { ts: requestTs } = await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
      text: (marker) =>
        `<@${botUserId}> 請用 event 工具排一個 10 秒後的 one-shot 提醒，提醒文字必須原樣包含 ${token}。排好後只回覆「已排程」。(${marker})`,
    });

    const reply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      afterTs: requestTs,
      timeoutMs: Math.max(env.timeoutMs, 90_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    expect(reply, `no one-shot reminder reply containing ${token}`).not.toBeNull();
    console.log(`one-shot reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });
});
