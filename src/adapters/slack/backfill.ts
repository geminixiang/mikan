import { WebClient } from "@slack/web-api";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import * as log from "../../log.js";
import type { Attachment, ChannelStore } from "../../store.js";
import type { ExternalBotMessageEvent } from "./message-logging.js";
import type { SlackChannel, SlackUser } from "./types.js";

export interface BackfillDeps {
  workingDir: string;
  webClient: WebClient;
  botUserId: string | null;
  botId: string | null;
  users: Map<string, SlackUser>;
  stripOwnMention: (text?: string) => string;
  processAttachments: ChannelStore["processAttachments"];
  logToFile: (channel: string, entry: object) => void;
  logExternalMessagingBotMessage: (event: ExternalBotMessageEvent) => Promise<Attachment[]>;
}

async function getExistingTimestamps(workingDir: string, channelId: string): Promise<Set<string>> {
  const logPath = join(workingDir, channelId, "log.jsonl");
  const timestamps = new Set<string>();
  if (!existsSync(logPath)) return timestamps;

  const content = await readFile(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.ts) timestamps.add(entry.ts);
    } catch (err) {
      log.logWarning(
        `Skipping malformed log entry at ${logPath}:${i + 1}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return timestamps;
}

export async function backfillChannel(
  deps: BackfillDeps,
  channelId: string,
  upperBoundTs?: string,
): Promise<number> {
  const existingTs = await getExistingTimestamps(deps.workingDir, channelId);

  // Find the biggest ts in log.jsonl
  let lastLoggedTs: string | undefined;
  for (const ts of existingTs) {
    if (!lastLoggedTs || parseFloat(ts) > parseFloat(lastLoggedTs)) lastLoggedTs = ts;
  }

  type Message = {
    user?: string;
    bot_id?: string;
    app_id?: string;
    username?: string;
    bot_profile?: { app_id?: string; name?: string; real_name?: string };
    blocks?: unknown[];
    attachments?: unknown[];
    text?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
    files?: Array<{ name: string }>;
  };
  const allMessages: Message[] = [];

  let cursor: string | undefined;
  let pageCount = 0;
  const maxPages = 3;

  do {
    const result = await deps.webClient.conversations.history({
      channel: channelId,
      oldest: lastLoggedTs, // Only fetch messages newer than what we have
      latest: upperBoundTs, // Do not race live socket events after startup
      inclusive: false,
      limit: 1000,
      cursor,
    });
    if (result.messages) {
      allMessages.push(...(result.messages as Message[]));
    }
    cursor = result.response_metadata?.next_cursor;
    pageCount++;
  } while (cursor && pageCount < maxPages);

  // Filter: include mikan's messages, external app/bot messages, and user messages.
  const relevantMessages = allMessages.filter((msg) => {
    if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
    if (msg.user === deps.botUserId) return true;
    const isExternalMessagingBotMessage = !!msg.bot_id || msg.subtype === "bot_message";
    if (isExternalMessagingBotMessage) {
      if (deps.botId && msg.bot_id === deps.botId) return false;
      if (
        msg.subtype !== undefined &&
        msg.subtype !== "bot_message" &&
        msg.subtype !== "file_share"
      ) {
        return false;
      }
      return (
        !!msg.text ||
        !!(msg.files && msg.files.length > 0) ||
        !!msg.blocks?.length ||
        !!msg.attachments?.length
      );
    }
    if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
    if (!msg.user) return false;
    if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
    return true;
  });

  // Reverse to chronological order
  relevantMessages.reverse();

  // Log each message to log.jsonl
  for (const msg of relevantMessages) {
    const isMikanMessage = msg.user === deps.botUserId;
    const isExternalMessagingBotMessage =
      !isMikanMessage && (!!msg.bot_id || msg.subtype === "bot_message");
    if (isExternalMessagingBotMessage) {
      await deps.logExternalMessagingBotMessage({ ...msg, channel: channelId, ts: msg.ts! });
      continue;
    }

    const user = deps.users.get(msg.user!);
    const text = deps.stripOwnMention(msg.text);
    const attachments = msg.files
      ? await deps.processAttachments(channelId, msg.files, msg.ts!)
      : [];

    deps.logToFile(channelId, {
      date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
      ts: msg.ts!,
      threadTs: msg.thread_ts,
      user: isMikanMessage ? "bot" : msg.user!,
      userName: isMikanMessage ? undefined : user?.userName,
      displayName: isMikanMessage ? undefined : user?.displayName,
      text,
      attachments,
      isMessagingBot: isMikanMessage,
    });
  }

  return relevantMessages.length;
}

export async function backfillAllChannels(
  deps: BackfillDeps & { channels: Map<string, SlackChannel> },
  upperBoundTs?: string,
): Promise<void> {
  const startTime = Date.now();

  // Only backfill channels that already have a log.jsonl (mikan has interacted with them before)
  const channelsToBackfill: Array<[string, SlackChannel]> = [];
  for (const [channelId, channel] of deps.channels) {
    const logPath = join(deps.workingDir, channelId, "log.jsonl");
    if (existsSync(logPath)) {
      channelsToBackfill.push([channelId, channel]);
    }
  }

  log.logBackfillStart(channelsToBackfill.length);

  let totalMessages = 0;
  for (const [channelId, channel] of channelsToBackfill) {
    try {
      const count = await backfillChannel(deps, channelId, upperBoundTs);
      if (count > 0) log.logBackfillChannel(channel.name, count);
      totalMessages += count;
    } catch (error) {
      log.logWarning(`Failed to backfill #${channel.name}`, String(error));
    }

    // Add delay between channels to avoid hitting Slack rate limits
    if (channelId !== channelsToBackfill[channelsToBackfill.length - 1][0]) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const durationMs = Date.now() - startTime;
  log.logBackfillComplete(totalMessages, durationMs);
}
