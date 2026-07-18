import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  summarizeMessage,
  uploadFiles,
  waitForRecentBotReply,
} from "./helpers/slack.js";

// Valid 1x1 orange PNG (8-bit RGB), generated offline and verified with `file`.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP438AAAAQBAYDFKhhdAAAAAElFTkSuQmCC",
  "base64",
);

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack image upload", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-022 mikan handles an image upload without crashing", async () => {
    const token = `QA_IMG_${Date.now()}`;
    const startedAt = nowSeconds();
    await uploadFiles(
      client,
      env.channel,
      [{ filename: `mikan-slack-e2e-image-${token}.png`, content: PNG_1X1 }],
      `<@${botUserId}> 這是一張測試圖片。無論你能否讀取圖片內容，請在回覆中原樣包含 token ${token}`,
    );
    const reply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 60_000),
      pollMs: env.pollMs,
      textIncludes: token,
    });
    expect(reply, `no image-upload reply containing ${token}`).not.toBeNull();
    console.log(`image reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  }, 180_000);
});
