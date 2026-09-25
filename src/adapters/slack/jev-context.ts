import { join } from "node:path";
import { isRecord, readTextFileIfExists } from "../../file-guards.js";
import { OFFICE_LOG_FILENAME } from "../../office/index.js";

export interface RecentLine {
  ts: string;
  speaker: string;
  text: string;
  isMikan: boolean;
}

export type SlackNameResolver = (userId: string) => string | undefined;

export function humanizeMentions(
  text: string,
  resolve: SlackNameResolver,
  botUserId: string | null,
): string {
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_match, id: string) => {
    if (botUserId && id === botUserId) return "@mikan";
    const name = resolve(id);
    return name ? `@${name}` : `@${id}`;
  });
}

export function readRecentScope(
  conversationDir: string,
  event: { ts: string; thread_ts?: string },
  options: { limit?: number; humanize?: (text: string) => string } = {},
): RecentLine[] {
  const limit = options.limit ?? 12;
  const humanize = options.humanize ?? ((text: string) => text);
  const raw = readTextFileIfExists(join(conversationDir, OFFICE_LOG_FILENAME));
  if (raw === undefined) return [];
  const lines: RecentLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || typeof entry.ts !== "string" || typeof entry.text !== "string") {
      continue;
    }
    const threadTs = typeof entry.threadTs === "string" ? entry.threadTs : undefined;
    const inScope = event.thread_ts
      ? threadTs === event.thread_ts || entry.ts === event.thread_ts
      : threadTs === undefined;
    if (!inScope || entry.ts === event.ts) continue;
    const isMikan = entry.isMessagingBot === true && entry.user === "bot";
    const speaker = isMikan
      ? "mikan"
      : String(entry.displayName ?? entry.userName ?? entry.user ?? "unknown");
    const previous = lines.at(-1);
    if (previous && previous.isMikan && isMikan && previous.ts === entry.ts) {
      previous.text += entry.text;
      continue;
    }
    lines.push({ ts: entry.ts, speaker, text: entry.text, isMikan });
  }
  for (const line of lines) line.text = humanize(line.text);
  return lines.slice(-limit);
}

export function formatRecentScope(lines: RecentLine[]): string {
  return lines.length ? lines.map((l) => `- ${l.speaker}: ${l.text}`).join("\n") : "(none)";
}
