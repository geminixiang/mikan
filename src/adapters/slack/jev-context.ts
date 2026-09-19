import { join } from "node:path";
import { isRecord, readTextFileIfExists } from "../../file-guards.js";

export interface RecentLine {
  ts: string;
  speaker: string;
  text: string;
  isMikan: boolean;
}

/**
 * Recent messages from log.jsonl in the same scope as `event` — the channel's
 * top level, or one thread (root included) — oldest first. Streamed bot
 * responses are logged in chunks sharing one ts and are merged back into one
 * line. Jev decisions score these alongside the new message, since a bare
 * "好啊" or "好了嗎" cannot be judged on its own.
 */
export function readRecentScope(
  conversationDir: string,
  event: { ts: string; thread_ts?: string },
  limit = 12,
): RecentLine[] {
  const raw = readTextFileIfExists(join(conversationDir, "log.jsonl"));
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
  return lines.slice(-limit);
}

export function formatRecentScope(lines: RecentLine[]): string {
  return lines.length ? lines.map((l) => `- ${l.speaker}: ${l.text}`).join("\n") : "(none)";
}
