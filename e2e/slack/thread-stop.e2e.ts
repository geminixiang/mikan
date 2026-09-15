import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  LOCAL_DELIVERY_TIMEOUT_MS,
  nowSeconds,
  postMessage,
  postLocallyDeliveredMessage,
  waitForThreadBotReply,
  sleep,
  fetchThreadMessages,
} from "./helpers/slack.js";
const ctx = loadContextOrSkip();
describe.skipIf(!ctx?.env.mikanBotUserId)("Slack thread stop routing", () => {
  if (!ctx?.env.mikanBotUserId) return;
  const { client, env } = ctx;
  it("bare stop stays in its thread and reaches Stopped", async () => {
    const marker = `QA_THREAD_STOP_${Date.now()}`;
    const root = await postMessage(client, env.channel, marker);
    const start = nowSeconds();
    await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      threadTs: root,
      text: (delivery) =>
        `<@${env.mikanBotUserId}> ${delivery} 請用 bash 執行 sleep 90，工具 label 必須是 ${marker}。不要先回覆完成，不要排程事件。`,
      timeoutMs: LOCAL_DELIVERY_TIMEOUT_MS,
      pollMs: env.pollMs,
    });
    try {
      const working = await waitForThreadBotReply({
        client,
        channel: env.channel,
        botUserId: env.mikanBotUserId!,
        rootTs: root,
        excludeTs: new Set([root]),
        startedAt: start,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textIncludes: marker,
      });
      expect(working, "no visible work in thread").not.toBeNull();
      const stopStart = nowSeconds();
      await postMessage(client, env.channel, "stop", root);
      const stopped = await waitForThreadBotReply({
        client,
        channel: env.channel,
        botUserId: env.mikanBotUserId!,
        rootTs: root,
        excludeTs: new Set([root]),
        startedAt: stopStart,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textMatches: /^Stopped\./,
      });
      expect(stopped, "stop did not finish in the originating thread").not.toBeNull();
      const recent = await client.conversations.history({
        channel: env.channel,
        oldest: String(stopStart),
        limit: 30,
      });
      expect(
        recent.messages?.filter(
          (m) => m.user === env.mikanBotUserId && (m.text ?? "").startsWith("Stopp"),
        ),
      ).toEqual([]);
      await sleep(1000);
      const thread = await fetchThreadMessages(client, env.channel, root);
      expect(
        thread.some((m) => m.ts === stopped!.ts && (m.text ?? "").startsWith("Stopped.")),
      ).toBe(true);
    } finally {
      // An assertion failure must not leave a 90-second run blocking later cases.
      await postMessage(client, env.channel, "stop", root);
    }
  }, 180000);
});
