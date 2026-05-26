import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { assertNoBotReplyToRoot, postMessage, summarizeMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx)("Slack no mention", () => {
  if (!ctx) return;
  const { client, env } = ctx;
  const botUserIds = [env.questionBotUserId, env.mikanBotUserId].filter((id): id is string =>
    Boolean(id),
  );

  it.skipIf(botUserIds.length === 0)("S-005 plain messages do not trigger any bot", async () => {
    const rootTs = await postMessage(
      client,
      env.channel,
      `QA no-mention smoke ${new Date().toISOString()}`,
    );
    const unexpected = await assertNoBotReplyToRoot({
      client,
      channel: env.channel,
      rootTs,
      botUserIds,
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
