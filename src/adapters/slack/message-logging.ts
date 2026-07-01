import type { Attachment, ChannelStore } from "../../store.js";
import type { SlackEvent, SlackUser } from "./types.js";

export interface ExternalBotMessageEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  username?: string;
  bot_profile?: { app_id?: string; name?: string; real_name?: string };
  blocks?: unknown[];
  attachments?: unknown[];
  files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
}

function collectSlackText(value: unknown, parts: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) parts.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSlackText(item, parts);
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  for (const key of ["text", "fallback", "title", "value"] as const) {
    collectSlackText(obj[key], parts);
  }
  collectSlackText(obj.fields, parts);
  collectSlackText(obj.elements, parts);
  collectSlackText(obj.blocks, parts);
}

function buildSlackAppMessageText(event: {
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}): string {
  const parts: string[] = [];
  collectSlackText(event.text, parts);
  collectSlackText(event.blocks, parts);
  collectSlackText(event.attachments, parts);
  const deduped = parts.filter((part, index) => parts.indexOf(part) === index);
  return deduped.join("\n");
}

export interface MessageLoggingDeps {
  users: Map<string, SlackUser>;
  processAttachments: ChannelStore["processAttachments"];
  logToFile: (channel: string, entry: object) => void;
}

export async function logUserMessage(
  deps: MessageLoggingDeps,
  event: SlackEvent,
): Promise<Attachment[]> {
  const user = deps.users.get(event.user);
  let attachments: Attachment[] = [];
  let attachmentError: unknown;
  if (event.files) {
    try {
      attachments = await deps.processAttachments(event.channel, event.files, event.ts);
    } catch (err) {
      attachmentError = err;
    }
  }
  // Always write the text log, even if attachment processing failed — we want
  // a record of the user message regardless of file-handling errors.
  deps.logToFile(event.channel, {
    date: new Date(parseFloat(event.ts) * 1000).toISOString(),
    ts: event.ts,
    threadTs: event.thread_ts,
    user: event.user,
    userName: user?.userName,
    displayName: user?.displayName,
    text: event.text,
    attachments,
    isMessagingBot: false,
  });
  if (attachmentError) throw attachmentError;
  return attachments;
}

export async function logExternalMessagingBotMessage(
  deps: MessageLoggingDeps,
  event: ExternalBotMessageEvent,
): Promise<Attachment[]> {
  const attachments = event.files
    ? await deps.processAttachments(event.channel, event.files, event.ts)
    : [];
  const botName =
    event.username ?? event.bot_profile?.name ?? event.bot_profile?.real_name ?? event.bot_id;
  deps.logToFile(event.channel, {
    date: new Date(parseFloat(event.ts) * 1000).toISOString(),
    ts: event.ts,
    threadTs: event.thread_ts,
    user: event.bot_id ? `bot:${event.bot_id}` : "external-bot",
    userName: botName,
    displayName: botName,
    text: buildSlackAppMessageText(event),
    attachments,
    isMessagingBot: true,
    botId: event.bot_id,
    appId: event.app_id ?? event.bot_profile?.app_id,
    subtype: event.subtype,
  });
  return attachments;
}
