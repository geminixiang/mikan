import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createOfficeAddress, officeDir } from "../../src/office/index.js";
import { resolveChannelSessionFile } from "../../src/sessions/store.js";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  LOCAL_DELIVERY_TIMEOUT_MS,
  nowSeconds,
  openDmChannel,
  postLocallyDeliveredMessage,
  sleep,
  waitForBotReply,
} from "./helpers/slack.js";

const RESET_SUCCESS = "Conversation reset. Send a new message to start fresh.";
const RESET_FAILURE = /Could not preserve memory|current conversation was not reset/i;
const ctx = loadContextOrSkip();

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

  it("S-024 /new creates a Clean session without changing durable memory", async () => {
    const dmChannel = await openDmChannel(client, botUserId);
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const scratchNonce = `scratch-${nonce}`;

    const setupStartedAt = nowSeconds();
    const { ts: setupTs, deliveryMarker: setupMarker } = await postLocallyDeliveredMessage({
      client,
      channel: dmChannel,
      workingDir: env.workingDir,
      text: (deliveryMarker) =>
        `這個 session 的暫時註記是 ${scratchNonce}。請只簡短回覆 OK，並原樣附上 ${deliveryMarker}。`,
      timeoutMs: LOCAL_DELIVERY_TIMEOUT_MS,
      pollMs: env.pollMs,
    });
    const setupReply = await waitForBotReply({
      client,
      channel: dmChannel,
      botUserId,
      rootTs: setupTs,
      startedAt: setupStartedAt,
      timeoutMs: Math.max(env.timeoutMs, 45_000),
      pollMs: env.pollMs,
      textIncludes: setupMarker,
    });
    expect(setupReply, "no acknowledgement to the setup turn").not.toBeNull();

    const conversationDir = officeDir(env.workingDir, createOfficeAddress("slack", dmChannel));
    const memoryPath = join(conversationDir, "MEMORY.md");
    const memoryAnchor = `# E2E Memory anchor\n\nStable nonce: ${nonce}\n`;
    writeFileSync(memoryPath, memoryAnchor);
    const originalSession = resolveChannelSessionFile(conversationDir);
    expect(originalSession, "no active session before /new").not.toBeNull();
    expect(readFileSync(originalSession!, "utf-8")).toContain(scratchNonce);

    // Slack does not let this QA Web API client invoke another app's slash command.
    // A literal /pi-new DM reaches the same command and reset path.
    const { ts: resetTs } = await postLocallyDeliveredMessage({
      client,
      channel: dmChannel,
      workingDir: env.workingDir,
      text: () => "/pi-new",
      timeoutMs: LOCAL_DELIVERY_TIMEOUT_MS,
      pollMs: env.pollMs,
    });
    const resetResult = await waitForResetResult(
      dmChannel,
      botUserId,
      resetTs,
      Math.max(env.timeoutMs, 60_000),
      env.pollMs,
    );
    expect(resetResult, "timed out waiting for /pi-new reset").not.toBeNull();
    expect(resetResult?.success, `reset failed: ${resetResult?.text ?? "no result"}`).toBe(true);
    expect(resetResult?.text.trim()).toBe(RESET_SUCCESS);

    const cleanSession = resolveChannelSessionFile(conversationDir);
    expect(cleanSession, "no active session after /new").not.toBeNull();
    expect(cleanSession).not.toBe(originalSession);
    expect(existsSync(originalSession!)).toBe(true);
    expect(readFileSync(cleanSession!, "utf-8")).not.toContain(scratchNonce);
    expect(readFileSync(memoryPath, "utf-8")).toBe(memoryAnchor);
    // Worst case: two local-delivery cycles (4 x 15s each) + setup reply + reset result.
  }, 300_000);
});
