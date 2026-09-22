import { LogLevel, WebClient } from "@slack/web-api";

interface Message {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: Array<{ name: string; url_private?: string }>;
}

function formatTs(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function formatMessage(ts: string, user: string, text: string, indent = ""): string {
  const prefix = `[${formatTs(ts)}] ${user}: `;
  const lines = text.split("\n");
  const firstLine = `${indent}${prefix}${lines[0]}`;
  if (lines.length === 1) return firstLine;
  const contentIndent = indent + " ".repeat(prefix.length);
  return [firstLine, ...lines.slice(1).map((l) => contentIndent + l)].join("\n");
}

export async function downloadChannel(channelId: string, botToken: string): Promise<void> {
  const client = new WebClient(botToken, { logLevel: LogLevel.ERROR });

  console.error(`Fetching channel info for ${channelId}...`);
  const channelName = await resolveChannelName(client, channelId);
  console.error(`Downloading history for #${channelName} (${channelId})...`);

  const messages = await fetchHistory(client, channelId);
  messages.reverse();

  const threadReplies = await fetchThreadReplies(client, channelId, messages);
  const totalReplies = printTranscript(messages, threadReplies);
  console.error(`Done! ${messages.length} messages, ${totalReplies} thread replies`);
}

async function resolveChannelName(client: WebClient, channelId: string): Promise<string> {
  try {
    const info = await client.conversations.info({ channel: channelId });
    return typeof info.channel?.name === "string" ? info.channel.name : channelId;
  } catch {
    return channelId;
  }
}

interface Page {
  messages?: unknown[];
  response_metadata?: { next_cursor?: string };
}

async function* pages(fetchPage: (cursor?: string) => Promise<Page>): AsyncGenerator<Message[]> {
  let cursor: string | undefined;
  do {
    const response = await fetchPage(cursor);
    yield (response.messages ?? []) as Message[];
    cursor = response.response_metadata?.next_cursor;
  } while (cursor);
}

async function fetchHistory(client: WebClient, channelId: string): Promise<Message[]> {
  const messages: Message[] = [];
  const fetchPage = (cursor?: string) =>
    client.conversations.history({ channel: channelId, limit: 200, cursor });
  for await (const page of pages(fetchPage)) {
    messages.push(...page);
    console.error(`  Fetched ${messages.length} messages...`);
  }
  return messages;
}

async function fetchThreadReplies(
  client: WebClient,
  channelId: string,
  messages: readonly Message[],
): Promise<Map<string, Message[]>> {
  const parents = messages.filter((message) => message.reply_count && message.reply_count > 0);
  console.error(`Fetching ${parents.length} threads...`);

  const threadReplies = new Map<string, Message[]>();
  for (const [index, parent] of parents.entries()) {
    console.error(`  Thread ${index + 1}/${parents.length} (${parent.reply_count} replies)...`);
    threadReplies.set(parent.ts, await fetchReplies(client, channelId, parent.ts));
  }
  return threadReplies;
}

async function fetchReplies(client: WebClient, channelId: string, ts: string): Promise<Message[]> {
  const replies: Message[] = [];
  const fetchPage = (cursor?: string) =>
    client.conversations.replies({ channel: channelId, ts, limit: 200, cursor });
  for await (const page of pages(fetchPage)) {
    replies.push(...page.slice(1));
  }
  return replies;
}

function printTranscript(
  messages: readonly Message[],
  threadReplies: ReadonlyMap<string, Message[]>,
): number {
  let totalReplies = 0;
  for (const message of messages) {
    console.log(formatMessage(message.ts, message.user || "unknown", message.text || ""));
    for (const reply of threadReplies.get(message.ts) ?? []) {
      console.log(formatMessage(reply.ts, reply.user || "unknown", reply.text || "", "  "));
      totalReplies++;
    }
  }
  return totalReplies;
}
