import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postLocallyDeliveredMessage,
  postMessage,
  sleep,
  summarizeMessage,
  waitForRecentBotReply,
  waitForThreadBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack event thread fork", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("event creates a top-level anchor whose thread continues the fork session", async () => {
    const eventToken = `QA_EVENT_FORK_${Date.now()}`;
    const followupToken = `QA_EVENT_THREAD_${Date.now()}`;
    const startedAt = nowSeconds();

    // Schedule through the agent's event tool: events are host-only office state.
    const { ts: requestTs } = await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
      text: (marker) =>
        `<@${botUserId}> 請用 event 工具排一個 10 秒後的 one-shot 提醒，提醒文字必須原樣包含 ${eventToken}。排好後只回覆「已排程」。(${marker})`,
    });

    const eventReply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      afterTs: requestTs,
      timeoutMs: Math.max(env.timeoutMs, 90_000),
      pollMs: env.pollMs,
      textIncludes: eventToken,
    });
    expect(eventReply, `no top-level event reply containing ${eventToken}`).not.toBeNull();

    const anchorTs = String(eventReply!.ts);
    expect(anchorTs).toMatch(/^\d+\.\d+$/);
    expect(
      !eventReply!.thread_ts || eventReply!.thread_ts === anchorTs,
      `event reply should be top-level, got thread_ts=${eventReply!.thread_ts}`,
    ).toBe(true);

    await sleep(Math.max(env.pollMs, 3_000));

    const threadStartedAt = nowSeconds();
    // CI may post QA messages from a bot token. Use an explicit mention so this
    // exercises the "mikan needs to reply" thread-fork path without weakening
    // bot-to-bot loop protection for bare bot messages.
    const userThreadTs = await postMessage(
      client,
      env.channel,
      `<@${botUserId}> Thread follow-up for event fork. Reply with exactly this token: ${followupToken}`,
      anchorTs,
    );

    const threadReply = await waitForThreadBotReply({
      client,
      channel: env.channel,
      botUserId,
      rootTs: anchorTs,
      startedAt: threadStartedAt,
      excludeTs: new Set([anchorTs, userThreadTs]),
      timeoutMs: Math.max(env.timeoutMs, 60_000),
      pollMs: env.pollMs,
      textIncludes: followupToken,
    });

    expect(threadReply, `no event thread reply containing ${followupToken}`).not.toBeNull();
    expect(String(threadReply!.thread_ts ?? anchorTs), "reply not anchored to event thread").toBe(
      anchorTs,
    );
    expect(String(threadReply!.ts), "thread reply should not be the top-level anchor").not.toBe(
      anchorTs,
    );

    console.log(`event anchor ts=${anchorTs}: ${summarizeMessage(eventReply!)}`);
    console.log(`event thread reply ts=${threadReply!.ts}: ${summarizeMessage(threadReply!)}`);
  });
});
