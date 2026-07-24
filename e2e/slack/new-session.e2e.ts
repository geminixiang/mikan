import { beforeAll, describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  openDmChannel,
  postMessage,
  sleep,
  summarizeMessage,
  waitForBotReply,
} from "./helpers/slack.js";

const RESET_SUCCESS = "Conversation reset. Send a new message to start fresh.";
const RESET_FAILURE = /Could not preserve memory|current conversation was not reset/i;
const ctx = loadContextOrSkip();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForResetResult(
  channel: string,
  botUserId: string,
  afterTs: string,
  timeoutMs: number,
  pollMs: number,
): Promise<{ success: boolean; text: string } | null> {
  if (!ctx) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await ctx.client.conversations.history({
      channel,
      oldest: afterTs,
      inclusive: false,
      limit: 50,
    });
    if (!response.ok) {
      throw new Error(`conversations.history failed: ${response.error ?? "unknown"}`);
    }
    for (const message of response.messages ?? []) {
      if (message.user !== botUserId || typeof message.text !== "string") continue;
      if (RESET_FAILURE.test(message.text)) return { success: false, text: message.text };
      if (message.text.trim() === RESET_SUCCESS) return { success: true, text: message.text };
    }
    await sleep(pollMs);
  }
  return null;
}

describe.skipIf(!ctx || !ctx.env.mikanBotUserId)("Slack new DM session", () => {
  if (!ctx || !ctx.env.mikanBotUserId) return;
  const { client, env } = ctx;
  const botUserId = ctx.env.mikanBotUserId;

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

  it("S-024 /new preserves durable memory but discards transient context", async () => {
    const dmChannel = await openDmChannel(client, botUserId);
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const projectCodename = `Mikan-Orbit-${nonce}`;
    const scratchNonce = `scratch-${nonce}`;

    const setupStartedAt = nowSeconds();
    const setupTs = await postMessage(
      client,
      dmChannel,
      `這個對話所屬專案的長期代號是 ${projectCodename}。這是精確且持久的專案偏好，` +
        "在 /new 後仍必須使用；請將完整代號保存在此對話的 MEMORY.md，而非全域 MEMORY.md。" +
        `目前草稿的暫時註記是 ${scratchNonce}，只供這個 session 使用，不得寫入任何 MEMORY.md，` +
        "也不得在 reset 後保留。請只簡短回覆 OK。",
    );
    const setupReply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs: setupTs,
      startedAt: setupStartedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
    });
    expect(setupReply, "no acknowledgement to the memory setup turn").not.toBeNull();

    // Slack does not let this QA Web API client invoke another app's slash command.
    // A literal /pi-new DM is accepted by mikan's normal command parser and reaches
    // the same NewCommandHandler and ConversationRuntime reset path.
    const resetTs = await postMessage(client, dmChannel, "/pi-new");
    const resetResult = await waitForResetResult(
      dmChannel,
      botUserId,
      resetTs,
      Math.max(env.timeoutMs, 150_000),
      env.pollMs,
    );
    expect(resetResult, "timed out waiting for /pi-new maintenance and reset").not.toBeNull();
    expect(resetResult?.success, `reset failed: ${resetResult?.text ?? "no result"}`).toBe(true);
    expect(resetResult?.text.trim()).toBe(RESET_SUCCESS);

    const expected = `CODENAME=${projectCodename}; SCRATCH=UNKNOWN`;
    const exactExpected = new RegExp(`^${escapeRegExp(expected)}$`);
    const probe =
      "請從此對話已保存的長期記憶找出專案代號，並判斷先前草稿的暫時註記是否已知。" +
      "整個回覆必須嚴格為：CODENAME=<已保存的完整專案代號>; SCRATCH=UNKNOWN";
    const probeStartedAt = nowSeconds();
    const probeTs = await postMessage(client, dmChannel, probe);
    let probeReply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs: probeTs,
      startedAt: probeStartedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textMatches: exactExpected,
    });

    if (!probeReply) {
      const retryStartedAt = nowSeconds();
      const retryTs = await postMessage(
        client,
        dmChannel,
        "請修正格式並從此對話的長期記憶取得專案代號。" +
          "只回覆 CODENAME=<已保存的完整專案代號>; SCRATCH=UNKNOWN，" +
          "不要猜測、輸出暫時註記、加入其他文字或使用 Markdown。",
      );
      probeReply = await waitForBotReply({
        client,
        channel: dmChannel,
        botUserId,
        rootTs: retryTs,
        startedAt: retryStartedAt,
        timeoutMs: Math.max(env.timeoutMs, 45_000),
        pollMs: env.pollMs,
        textMatches: exactExpected,
      });
      expect(
        probeReply,
        `no exact post-reset reply after format repair: ${expected}`,
      ).not.toBeNull();
    }

    expect(probeReply?.text ?? "", "scratch nonce leaked after reset").not.toContain(scratchNonce);
    expect((probeReply?.text ?? "").trim()).toBe(expected);
    console.log(`new-session probe ts=${probeReply!.ts}: ${summarizeMessage(probeReply!)}`);
  }, 300_000);
});
