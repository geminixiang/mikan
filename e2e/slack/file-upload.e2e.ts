import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { nowSeconds, uploadTextFile, waitForRecentBotReply } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack file upload", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-009 mikan summarizes uploaded file and echoes token", async () => {
    const token = `QA_FILE_${Date.now()}`;
    const startedAt = nowSeconds();
    await uploadTextFile(
      client,
      env.channel,
      `mikan-slack-e2e-${token}.txt`,
      `Slack E2E file content. Token: ${token}\n請摘要這個檔案並原樣包含 token。\n`,
      `<@${botUserId}> 請摘要這個小文字檔，並在回覆中原樣包含 token ${token}`,
    );
    const reply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    expect(reply, `no file summary reply containing ${token}`).not.toBeNull();
  });
});
