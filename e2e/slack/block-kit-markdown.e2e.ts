import { describe, expect, it } from "vitest";
import { renderSlackBlocks } from "../../src/adapters/slack/blocks.js";
import { loadContextOrSkip } from "./helpers/client.js";
import { fetchThreadMessages, postMessage } from "./helpers/slack.js";

const ctx = loadContextOrSkip();

interface RichTextLink {
  type: string;
  url?: string;
  text?: string;
}

function findRichTextLinks(
  blocks: NonNullable<Awaited<ReturnType<typeof fetchThreadMessages>>[number]["blocks"]>,
): RichTextLink[] {
  const links: RichTextLink[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === "link") links.push(record as unknown as RichTextLink);
    if (Array.isArray(record.elements)) walk(record.elements);
  };
  walk(blocks);
  return links;
}

describe.skipIf(!ctx)("Slack Block Kit markdown", () => {
  if (!ctx) return;
  const { client, env } = ctx;

  it("S-024 renders response-source links as native Slack links", async () => {
    const token = `QA_MRKDWN_LINK_${Date.now()}`;
    const url = "https://github.com/livingbio/designers/issues/523";
    // Legacy Slack-style link in the response source; the renderer converts it
    // to GFM, and Slack translates the markdown block into a rich_text link.
    const source = `${token} <${url}|#523>`;
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

      const links = findRichTextLinks(canonicalMessage?.blocks ?? []);
      const link = links.find((candidate) => candidate.url === url);
      expect(link, `no rich_text link with url ${url} in canonical blocks`).toBeDefined();
      expect(link?.text).toBe("#523");
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
