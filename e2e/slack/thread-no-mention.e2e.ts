import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { assertNoAdditionalBotReply, postMessage, summarizeMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack thread no mention", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserIds = [ctx.env.mikanBotUserId];

  it("S-013 plain thread replies do not trigger mikan", async () => {
    const rootTs = await postMessage(
      client,
      env.channel,
      `QA thread no-mention root ${new Date().toISOString()}`,
    );
    const threadTs = await postMessage(
      client,
      env.channel,
      `QA thread no-mention reply ${new Date().toISOString()}`,
      rootTs,
    );

    const unexpected = await assertNoAdditionalBotReply({
      client,
      channel: env.channel,
      rootTs,
      botUserIds,
      afterTs: threadTs,
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
});
