import { formatLocalTimestamp } from "../utils/date.js";

/**
 * The prompt history-line grammar:
 *
 *   `[YYYY-MM-DD HH:MM:SS±HH:MM] [userName] [in-thread:ts]: text`
 *
 * agent.ts writes it when prompting the model; session resume strips the
 * prefix to compare platform log history against persisted session messages
 * (dedupe). Writer and parser live together here so the grammar cannot drift
 * apart silently — if the format changes, the round-trip test fails instead
 * of every resumed session duplicating its history.
 */
export function formatHistoryLine(options: {
  date?: Date;
  userName?: string;
  threadTs?: string;
  text: string;
}): string {
  const timestamp = options.date ? formatLocalTimestamp(options.date) : null;
  const timestampPart = timestamp ? `[${timestamp}] ` : "";
  const threadPart = options.threadTs ? ` [in-thread:${options.threadTs}]` : "";
  return `${timestampPart}[${options.userName || "unknown"}]${threadPart}: ${options.text}`;
}

const HISTORY_LINE_PREFIX =
  /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}\]\s+\[[^\]]+\](?:\s+\[in-thread:[^\]]+\])?:\s*/;

/** Strip the timestamped prefix so log text and session text compare equal. */
export function stripHistoryLinePrefix(text: string): string {
  return text.replace(HISTORY_LINE_PREFIX, "").trim();
}
