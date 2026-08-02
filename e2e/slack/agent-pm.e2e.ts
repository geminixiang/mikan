import { describe, expect, it } from "vitest";
import { loadContextOrSkip } from "./helpers/client.js";
import {
  nowSeconds,
  postLocallyDeliveredMessage,
  summarizeMessage,
  waitForRecentBotReply,
} from "./helpers/slack.js";

/**
 * End-to-end cover for the `agent-pm` example extension: a pipeline stage
 * driven from Slack, running host-side, delivering back to Slack.
 *
 * What only a live run can show is the seam between mikan and an extension —
 * that a contributed command reaches the extension without a model call, that
 * `api.notify` actually posts, and that its return value is a usable message
 * id. The pipeline's own logic is covered locally.
 *
 * Requires the extension installed with `controlConversationId` pointing at
 * the QA channel and `deliveryMode: "test"`; the CI workflow writes that
 * config before booting mikan. Skips when the harness is not configured.
 *
 * Note the commands go through `chat.postMessage`, which posts `/pm …` as
 * literal text. A human typing that into the Slack client would have it
 * intercepted as a slash command and never delivered — extension commands are
 * reachable here precisely because the API does not interpret them.
 */
const ctx = loadContextOrSkip();

describe.skipIf(!ctx)("agent-pm example extension", () => {
  if (!ctx) return;
  const { client, env } = ctx;

  it.skipIf(!env.mikanBotUserId)("S-023 /pm status reports a configured pipeline", async () => {
    const botUserId = env.mikanBotUserId;
    if (!botUserId) return;
    const startedAt = nowSeconds();
    const { ts: rootTs } = await postLocallyDeliveredMessage({
      client,
      channel: env.channel,
      workingDir: env.workingDir,
      text: () => `<@${botUserId}> /pm status`,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
    });

    const reply = await waitForRecentBotReply({
      client,
      channel: env.channel,
      botUserId,
      startedAt,
      afterTs: rootTs,
      timeoutMs: env.timeoutMs,
      pollMs: env.pollMs,
      textIncludes: "agent-pm",
    });

    expect(reply, "no /pm status reply — is the extension installed?").not.toBeNull();
    const text = reply!.text ?? "";
    console.log(`status reply: ${summarizeMessage(reply!)}`);

    // Delivery must be diverted. A live-mode pipeline in the QA channel
    // would mean the guard that keeps this off real team channels is not
    // working, which is the one failure worth catching loudly.
    //
    // Matched loosely on purpose: mikan renders markdown into native Block Kit,
    // so what history returns is the plain-text fallback with the source
    // markup already consumed — asserting on backticks tests the renderer, not
    // the pipeline.
    expect(text, "pipeline is not in test delivery mode").toMatch(/delivery:\s*`?test`?/);
    expect(text, "no conversation owns the schedules").toContain("schedules owned by:");
  });

  it.skipIf(!env.mikanBotUserId)(
    "S-024 /pm all runs every stage and delivers the heartbeat",
    async () => {
      const botUserId = env.mikanBotUserId;
      if (!botUserId) return;
      const startedAt = nowSeconds();
      const { ts: rootTs } = await postLocallyDeliveredMessage({
        client,
        channel: env.channel,
        workingDir: env.workingDir,
        text: () => `<@${botUserId}> /pm all`,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
      });

      // Dispatched deterministically: no agent run, no model call, so this
      // returns as fast as the stages themselves.
      const reply = await waitForRecentBotReply({
        client,
        channel: env.channel,
        botUserId,
        startedAt,
        afterTs: rootTs,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textIncludes: "ingest:",
      });

      expect(reply, "no /pm all reply").not.toBeNull();
      const text = reply!.text ?? "";
      console.log(`run reply: ${summarizeMessage(reply!)}`);
      expect(text, "run stage did not report").toMatch(/run: \d+ processed/);
      expect(text, "sweep stage did not report").toMatch(/sweep: \d+ overdue/);

      // The heartbeat is a workflow the run stage dispatches, and it delivers
      // through api.notify — so its arrival is the proof that the extension
      // can post on its own rather than only reply.
      const heartbeat = await waitForRecentBotReply({
        client,
        channel: env.channel,
        botUserId,
        startedAt,
        timeoutMs: env.timeoutMs,
        pollMs: env.pollMs,
        textIncludes: "events pending",
      });

      expect(heartbeat, "pipeline produced no heartbeat delivery").not.toBeNull();
      const heartbeatText = heartbeat!.text ?? "";
      console.log(`heartbeat: ${summarizeMessage(heartbeat!)}`);
      expect(heartbeatText, "heartbeat was not test-mode routed").toContain("[agent-pm test");
    },
  );
});
