import { WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { assertBotTokenShape } from "./helpers/env.js";
import { loadContextOrSkip } from "./helpers/client.js";
import { fetchThreadMessages, postMessage, sleep } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

describe.skipIf(!ctx || !ctx.env.streamingBotToken)("Slack streaming API", () => {
  if (!ctx || !ctx.env.streamingBotToken) return;
  const { client, env } = ctx;
  assertBotTokenShape(env.streamingBotToken);
  const botClient = new WebClient(env.streamingBotToken);

  it("S-011 appendStream appends only deltas without duplicating prior text", async () => {
    const token = `STREAM_E2E_${Date.now()}`;
    const initial = `${token} alpha`;
    const delta = " beta";
    const final = `${initial}${delta}`;
    let rootTs: string | undefined;
    let streamTs: string | undefined;

    try {
      rootTs = await postMessage(client, env.channel, `Slack streaming e2e root ${token}`);
      const [botAuth, userAuth] = await Promise.all([botClient.auth.test(), client.auth.test()]);
      const recipientTeamId = typeof botAuth.team_id === "string" ? botAuth.team_id : undefined;
      const recipientUserId = typeof userAuth.user_id === "string" ? userAuth.user_id : undefined;
      const start = await botClient.apiCall("chat.startStream", {
        channel: env.channel,
        thread_ts: rootTs,
        markdown_text: initial,
        ...(recipientTeamId ? { recipient_team_id: recipientTeamId } : {}),
        ...(recipientUserId ? { recipient_user_id: recipientUserId } : {}),
      });
      streamTs = String((start as { ts?: string }).ts ?? "");
      expect(streamTs, `chat.startStream missing ts: ${JSON.stringify(start)}`).not.toBe("");

      await botClient.apiCall("chat.appendStream", {
        channel: env.channel,
        ts: streamTs,
        markdown_text: delta,
      });
      await botClient.apiCall("chat.stopStream", { channel: env.channel, ts: streamTs });

      const deadline = Date.now() + Math.max(env.timeoutMs, 20_000);
      let actualText = "";
      while (Date.now() < deadline) {
        const messages = await fetchThreadMessages(client, env.channel, rootTs);
        const streamedMessage = messages.find((message) => String(message.ts) === streamTs);
        actualText = streamedMessage?.text ?? "";
        if (actualText.includes(final)) break;
        await sleep(env.pollMs);
      }

      expect(actualText).toContain(final);
      expect(actualText).not.toContain(`${initial}${initial}`);
      expect(actualText.match(new RegExp(token, "g"))?.length).toBe(1);
    } finally {
      if (streamTs) {
        await botClient.chat.delete({ channel: env.channel, ts: streamTs }).catch(() => undefined);
      }
      if (rootTs) {
        await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
      }
    }
  });
});
