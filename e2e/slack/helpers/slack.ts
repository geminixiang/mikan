import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createOfficeAddress, officeKey } from "../../../src/office/index.js";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

export interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  blocks?: KnownBlock[];
}

export function nowSeconds(): number {
  return Date.now() / 1000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message: SlackMessage): string {
  return typeof message.text === "string" ? message.text : "";
}

function isTargetBotMessage(message: SlackMessage, botUserId: string): boolean {
  return message.user === botUserId || message.bot_id === botUserId;
}

export function summarizeMessage(message: SlackMessage): string {
  const text = messageText(message).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export async function postMessage(
  client: WebClient,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string> {
  const res = await client.chat.postMessage({ channel, text, thread_ts: threadTs });
  if (!res.ok || !res.ts) throw new Error(`chat.postMessage failed: ${res.error ?? "missing ts"}`);
  return String(res.ts);
}

export interface PostLocallyDeliveredMessageOptions {
  client: WebClient;
  channel: string;
  workingDir: string;
  text: (deliveryMarker: string) => string;
  threadTs?: string;
  timeoutMs: number;
  pollMs: number;
  maxAttempts?: number;
}

/**
 * Socket Mode distributes one event to one connected client. A developer
 * daemon using the same app can therefore consume a QA event instead of the
 * GitHub runner. Retry with a unique marker until this runner's log proves it
 * received the exact Slack message; callers then match the same marker in the
 * reply so another daemon cannot satisfy the assertion.
 */
export async function postLocallyDeliveredMessage(
  options: PostLocallyDeliveredMessageOptions,
): Promise<{ ts: string; deliveryMarker: string }> {
  const maxAttempts = options.maxAttempts ?? 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deliveryMarker = `QA_DELIVERY_${Date.now()}_${attempt}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = await postMessage(
      options.client,
      options.channel,
      options.text(deliveryMarker),
      options.threadTs,
    );
    if (
      await waitForLocalLogMessage({
        workingDir: options.workingDir,
        channel: options.channel,
        ts,
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
      })
    ) {
      return { ts, deliveryMarker };
    }
  }
  throw new Error(
    `Slack events repeatedly went to another Socket Mode client instead of this E2E runner (${options.channel})`,
  );
}

async function waitForLocalLogMessage(options: {
  workingDir: string;
  channel: string;
  ts: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  // The daemon writes under the office-key layout, not the raw channel id.
  const logPath = join(
    options.workingDir,
    officeKey(createOfficeAddress("slack", options.channel)),
    "log.jsonl",
  );
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(logPath, "utf-8")).split("\n");
      if (
        lines.some((line) => {
          if (!line) return false;
          try {
            return (JSON.parse(line) as { ts?: unknown }).ts === options.ts;
          } catch {
            return false;
          }
        })
      ) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await sleep(options.pollMs);
  }
  return false;
}

export async function uploadTextFile(
  client: WebClient,
  channel: string,
  filename: string,
  content: string,
  initialComment: string,
): Promise<void> {
  const res = await client.files.uploadV2({
    channel_id: channel,
    file: Buffer.from(content),
    filename,
    title: filename,
    initial_comment: initialComment,
  });
  if (!res.ok) throw new Error(`files.uploadV2 failed: ${res.error ?? "unknown"}`);
}

export interface FileUploadSpec {
  filename: string;
  content: string | Buffer;
}

export async function uploadFiles(
  client: WebClient,
  channel: string,
  files: FileUploadSpec[],
  initialComment: string,
): Promise<void> {
  const res = await client.files.uploadV2({
    channel_id: channel,
    initial_comment: initialComment,
    file_uploads: files.map((spec) => ({
      file: Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content),
      filename: spec.filename,
      title: spec.filename,
    })),
  });
  if (!res.ok) throw new Error(`files.uploadV2 failed: ${res.error ?? "unknown"}`);
}

export async function openDmChannel(client: WebClient, userId: string): Promise<string> {
  const res = await client.conversations.open({ users: userId });
  const channelId = res.channel?.id;
  if (!res.ok || !channelId) {
    throw new Error(`conversations.open failed: ${res.error ?? "missing channel id"}`);
  }
  return channelId;
}

export async function fetchThreadMessages(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const res = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
  if (!res.ok) throw new Error(`conversations.replies failed: ${res.error ?? "unknown"}`);
  return (res.messages ?? []) as SlackMessage[];
}

async function fetchRecentMessages(
  client: WebClient,
  channel: string,
  oldest: number,
): Promise<SlackMessage[]> {
  const res = await client.conversations.history({
    channel,
    oldest: String(oldest),
    inclusive: false,
    limit: 50,
  });
  if (!res.ok) throw new Error(`conversations.history failed: ${res.error ?? "unknown"}`);
  return (res.messages ?? []) as SlackMessage[];
}

export interface WaitForBotReplyOptions {
  client: WebClient;
  channel: string;
  botUserId: string;
  rootTs: string;
  startedAt: number;
  timeoutMs: number;
  pollMs: number;
  textIncludes?: string;
  textMatches?: RegExp;
}

export async function waitForBotReply(opts: WaitForBotReplyOptions): Promise<SlackMessage | null> {
  const {
    client,
    channel,
    botUserId,
    rootTs,
    startedAt,
    timeoutMs,
    pollMs,
    textIncludes,
    textMatches,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [threadMessages, recentMessages] = await Promise.all([
      fetchThreadMessages(client, channel, rootTs).catch(() => [] as SlackMessage[]),
      fetchRecentMessages(client, channel, startedAt).catch(() => [] as SlackMessage[]),
    ]);

    const candidate = [...threadMessages, ...recentMessages]
      .filter((message) => String(message.ts) !== rootTs)
      .filter((message) => isTargetBotMessage(message, botUserId))
      .find((message) => {
        const text = messageText(message);
        if (textIncludes && !text.includes(textIncludes)) return false;
        if (textMatches && !textMatches.test(text)) return false;
        return true;
      });

    if (candidate) return candidate;
    await sleep(pollMs);
  }
  return null;
}

export interface WaitForThreadBotReplyOptions {
  client: WebClient;
  channel: string;
  botUserId: string;
  rootTs: string;
  startedAt: number;
  excludeTs: Set<string>;
  timeoutMs: number;
  pollMs: number;
  textIncludes?: string;
  textMatches?: RegExp;
}

export async function waitForThreadBotReply(
  opts: WaitForThreadBotReplyOptions,
): Promise<SlackMessage | null> {
  const {
    client,
    channel,
    botUserId,
    rootTs,
    startedAt,
    excludeTs,
    timeoutMs,
    pollMs,
    textIncludes,
    textMatches,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const threadMessages = await fetchThreadMessages(client, channel, rootTs).catch(
      () => [] as SlackMessage[],
    );
    const reply = threadMessages
      .filter((message) => String(message.ts) !== rootTs)
      .filter((message) => !excludeTs.has(String(message.ts)))
      .filter((message) => Number(message.ts) >= startedAt)
      .filter((message) => isTargetBotMessage(message, botUserId))
      .find((message) => {
        const text = messageText(message);
        if (textIncludes && !text.includes(textIncludes)) return false;
        if (textMatches && !textMatches.test(text)) return false;
        return true;
      });

    if (reply) return reply;
    await sleep(pollMs);
  }
  return null;
}

export interface WaitForRecentBotReplyOptions {
  client: WebClient;
  channel: string;
  botUserId: string;
  startedAt: number;
  timeoutMs: number;
  pollMs: number;
  /** Slack ts lower bound: only messages with ts strictly greater match (no local-clock skew). */
  afterTs?: string;
  textIncludes?: string;
  textMatches?: RegExp;
}

export async function waitForRecentBotReply(
  opts: WaitForRecentBotReplyOptions,
): Promise<SlackMessage | null> {
  const {
    client,
    channel,
    botUserId,
    startedAt,
    timeoutMs,
    pollMs,
    afterTs,
    textIncludes,
    textMatches,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recentMessages = await fetchRecentMessages(client, channel, startedAt).catch(
      () => [] as SlackMessage[],
    );
    const reply = recentMessages
      .filter((message) => isTargetBotMessage(message, botUserId))
      .filter((message) => !afterTs || Number(message.ts) > Number(afterTs))
      .find((message) => {
        const text = messageText(message);
        if (textIncludes && !text.includes(textIncludes)) return false;
        if (textMatches && !textMatches.test(text)) return false;
        return true;
      });

    if (reply) return reply;
    await sleep(pollMs);
  }
  return null;
}

export interface AssertNoAdditionalBotReplyOptions {
  client: WebClient;
  channel: string;
  rootTs: string;
  botUserIds: string[];
  afterTs: string;
  timeoutMs: number;
  pollMs: number;
}

export async function assertNoAdditionalBotReply(
  opts: AssertNoAdditionalBotReplyOptions,
): Promise<SlackMessage | null> {
  const { client, channel, rootTs, botUserIds, afterTs, timeoutMs, pollMs } = opts;
  const after = Number(afterTs);
  const seen = new Set([String(rootTs), String(afterTs)]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const threadMessages = await fetchThreadMessages(client, channel, rootTs).catch(
      () => [] as SlackMessage[],
    );
    const unexpected = threadMessages
      .filter((message) => !seen.has(String(message.ts)))
      .filter((message) => Number(message.ts) > after)
      .find((message) => botUserIds.some((botUserId) => isTargetBotMessage(message, botUserId)));
    if (unexpected) return unexpected;
    await sleep(pollMs);
  }
  return null;
}

export interface AssertNoBotReplyToRootOptions {
  client: WebClient;
  channel: string;
  rootTs: string;
  botUserIds: string[];
  timeoutMs: number;
  pollMs: number;
}

export async function assertNoBotReplyToRoot(
  opts: AssertNoBotReplyToRootOptions,
): Promise<SlackMessage | null> {
  const { client, channel, rootTs, botUserIds, timeoutMs, pollMs } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const threadMessages = await fetchThreadMessages(client, channel, rootTs).catch(
      () => [] as SlackMessage[],
    );
    const unexpected = threadMessages
      .filter((message) => String(message.ts) !== rootTs)
      .find((message) => botUserIds.some((botUserId) => isTargetBotMessage(message, botUserId)));
    if (unexpected) return unexpected;
    await sleep(pollMs);
  }
  return null;
}
