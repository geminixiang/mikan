import { join } from "node:path";
import { isRecord, readTextFileIfExists } from "../../file-guards.js";

/** The one question Jev answers for an unaddressed shared-channel message. */
export const JEV_ADDRESSED_INSTRUCTIONS =
  "Given the recent Slack conversation, does the NEW message address, ask, or request the mikan AI assistant to do something (including continuing something mikan was already helping with), rather than being conversation between humans that needs no reply from mikan?";

interface LogLine {
  ts: string;
  threadTs?: string;
  speaker: string;
  text: string;
  isMikan: boolean;
}

/** Recent messages in the same scope as `event` (channel top level or its thread), oldest first. */
function readRecentScope(
  conversationDir: string,
  event: { ts: string; thread_ts?: string },
  limit: number,
): LogLine[] {
  const raw = readTextFileIfExists(join(conversationDir, "log.jsonl"));
  if (raw === undefined) return [];
  const lines: LogLine[] = [];
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
    // Thread replies belong to their thread; everything else is the channel's top level.
    const inScope = event.thread_ts
      ? threadTs === event.thread_ts || entry.ts === event.thread_ts
      : threadTs === undefined;
    if (!inScope || entry.ts === event.ts) continue;
    const isMikan = entry.isMessagingBot === true && entry.user === "bot";
    const speaker = isMikan
      ? "mikan"
      : String(entry.displayName ?? entry.userName ?? entry.user ?? "unknown");
    const previous = lines.at(-1);
    // Streamed bot responses are logged in chunks sharing one ts; merge them.
    if (previous && previous.isMikan && isMikan && previous.ts === entry.ts) {
      previous.text += entry.text;
      continue;
    }
    lines.push({ ts: entry.ts, threadTs, speaker, text: entry.text, isMikan });
  }
  return lines.slice(-limit);
}

/**
 * Build the shared `state` Jev scores when deciding whether an unaddressed
 * shared-channel message is meant for mikan. A single line like "好啊" is
 * unjudgeable on its own, so the state carries the surrounding scope: the
 * channel's recent top-level messages, or the thread's messages plus whether
 * mikan has already taken part in it.
 */
export function buildAutoReplyState(
  conversationDir: string,
  event: { ts: string; thread_ts?: string; user: string; text: string },
  options: { speaker?: string; limit?: number } = {},
): string {
  const recent = readRecentScope(conversationDir, event, options.limit ?? 12);
  const header = event.thread_ts
    ? `Slack thread reply. mikan has ${recent.some((l) => l.isMikan) ? "already replied" : "not replied"} in this thread.`
    : "Slack channel top-level message.";
  const context = recent.length
    ? recent.map((l) => `- ${l.speaker}: ${l.text}`).join("\n")
    : "(none)";
  return [
    header,
    "",
    "Recent messages (oldest first):",
    context,
    "",
    `NEW message from ${options.speaker ?? event.user}:`,
    event.text,
  ].join("\n");
}
