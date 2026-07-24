import { describe, expect, it } from "vitest";
import { renderSlackBlocks } from "../../src/adapters/slack/blocks.js";
import { loadContextOrSkip } from "./helpers/client.js";
import { fetchThreadMessages, postMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

function findMrkdwnText(
  blocks: NonNullable<Awaited<ReturnType<typeof fetchThreadMessages>>[number]["blocks"]>,
): string[] {
  return blocks.flatMap((block) => {
    if (block.type !== "section" || !("text" in block) || block.text?.type !== "mrkdwn") return [];
    return [block.text.text];
  });
}

describe.skipIf(!ctx)("Slack Block Kit markdown", () => {
  if (!ctx) return;
  const { client, env } = ctx;

  it("S-024 preserves Slack mrkdwn links in canonical Block Kit messages", async () => {
    const token = `QA_MRKDWN_LINK_${Date.now()}`;
    const link = "<https://github.com/livingbio/designers/issues/523|#523>";
    const source = `${token} ${link}`;
    let rootTs: string | undefined;
    let messageTs: string | undefined;

    try {
      rootTs = await postMessage(client, env.channel, `Slack Block Kit e2e root ${token}`);
      const response = await client.chat.postMessage({
        channel: env.channel,
        thread_ts: rootTs,
        ...renderSlackBlocks(source),
      });
      expect(response.ok, `chat.postMessage failed: ${response.error ?? "unknown"}`).toBe(true);
      messageTs = response.ts;
      expect(messageTs, "chat.postMessage missing ts").toBeTruthy();

      const canonicalMessages = await fetchThreadMessages(client, env.channel, rootTs);
      const canonicalMessage = canonicalMessages.find(
        (message) => String(message.ts) === String(messageTs),
      );
      expect(
        canonicalMessage,
        "rendered message missing from canonical Slack thread",
      ).toBeDefined();

      const mrkdwnText = findMrkdwnText(canonicalMessage?.blocks ?? []).join("\n");
      expect(mrkdwnText).toContain(source);
      expect(mrkdwnText).not.toContain("issues/523%7C#523");
      expect(mrkdwnText).not.toContain(`${link.slice(1, -1)}|https://`);
    } finally {
      if (messageTs) {
        await client.chat.delete({ channel: env.channel, ts: messageTs }).catch(() => undefined);
      }
      if (rootTs) {
        await client.chat.delete({ channel: env.channel, ts: rootTs }).catch(() => undefined);
      }
    }
  });
});
