import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  LOCAL_DELIVERY_TIMEOUT_MS,
  waitForLocalLogMessage,
  sleep,
  summarizeMessage,
  uploadFiles,
  waitForRecentBotReply,
} from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack multi-file upload", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-021 mikan reads multiple uploaded files and echoes both tokens", async () => {
    const tokenA = `QA_MULTI_A_${Date.now()}`;
    const tokenB = `QA_MULTI_B_${Date.now()}`;
    const startedAt = nowSeconds();
    const fileIds = await uploadFiles(
      client,
      env.channel,
      [
        {
          filename: `mikan-slack-e2e-multi-a-${tokenA}.txt`,
          content: `Slack E2E multi-file A. Token: ${tokenA}\n`,
        },
        {
          filename: `mikan-slack-e2e-multi-b-${tokenB}.txt`,
          content: `Slack E2E multi-file B. Token: ${tokenB}\n`,
        },
      ],
      `<@${botUserId}> 請閱讀這兩個檔案，並在同一則回覆中原樣包含兩個 token`,
    );
    // Upload success is not proof that Slack shared the files to this channel.
    let shareTs: string | undefined;
    const deadline = Date.now() + LOCAL_DELIVERY_TIMEOUT_MS;
    while (!shareTs && Date.now() < deadline) {
      const history = await client.conversations.history({
        channel: env.channel,
        oldest: String(startedAt),
        limit: 50,
      });
      shareTs = history.messages?.find((message) =>
        fileIds.every((id) => message.files?.some((file) => file.id === id)),
      )?.ts;
      if (!shareTs) await sleep(env.pollMs);
    }
    expect(shareTs, `files ${fileIds.join(",")} were not shared to the QA channel`).toBeDefined();
    expect(
      await waitForLocalLogMessage({
        workingDir: env.workingDir,
        channel: env.channel,
        ts: shareTs!,
        timeoutMs: LOCAL_DELIVERY_TIMEOUT_MS,
        pollMs: env.pollMs,
      }),
      "shared files never reached this daemon's intake",
    ).toBe(true);
    const reply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 60_000),
      pollMs: env.pollMs,
      textIncludes: tokenA,
    });
    expect(reply, `no multi-file reply containing ${tokenA}`).not.toBeNull();

    // The second token normally lands in the same message; poll again so a
    // split reply still passes.
    const replyWithB = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      timeoutMs: Math.max(env.timeoutMs, 30_000),
      pollMs: env.pollMs,
      textIncludes: tokenB,
    });
    expect(replyWithB, `no multi-file reply containing ${tokenB}`).not.toBeNull();
    console.log(`multi-file reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  }, 180_000);
});
