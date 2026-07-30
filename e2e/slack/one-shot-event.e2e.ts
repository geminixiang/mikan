import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import { nowSeconds, summarizeMessage, waitForRecentBotReply } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack one-shot event", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

  it("S-011 one-shot event triggers mikan reply with token", async () => {
    const token = `QA_EVENT_${Date.now()}`;
    const filename = `slack-e2e-one-shot-${token}.json`;
    const at = new Date(Date.now() + 5_000).toISOString();
    const startedAt = nowSeconds();

    await mkdir(env.eventsDir, { recursive: true });
    await writeFile(
      join(env.eventsDir, filename),
      JSON.stringify(
        {
          type: "one-shot",
          platform: "slack",
          conversationId: env.channel,
          conversationKind: "shared",
          text: `One-shot E2E reminder. 請在回覆中原樣包含 ${token}`,
          at,
        },
        null,
        2,
      ),
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
    expect(reply, `no one-shot reminder reply containing ${token}`).not.toBeNull();
    console.log(`one-shot reply ts=${reply!.ts}: ${summarizeMessage(reply!)}`);
  });
});
