import { join } from "node:path";
import * as log from "../log.js";
import type { ConversationLogMessage } from "../types.js";
import { isRecord, parseJsonValue, readTextFileIfExists } from "../utils/file-guards.js";
import type { LogRecord } from "./types.js";

export type { LogRecord } from "./types.js";

/**
 * Read a conversation's platform chat log (log.jsonl): skip malformed lines,
 * and coalesce consecutive messaging-bot chunks that share a ts — streamed
 * responses are logged in pieces but represent one message.
 */
export function readConversationLog(conversationDir: string): LogRecord[] {
  const logFile = join(conversationDir, "log.jsonl");
  const raw = readTextFileIfExists(logFile);
  if (raw === undefined) return [];

  const lines = raw.trim().split("\n").filter(Boolean);
  const records: LogRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const message = parseJsonValue(
        lines[i],
        (value): value is ConversationLogMessage => isRecord(value),
        (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
      );
      records.push({ message, index: i });
    } catch (err) {
      log.logWarning(
        `Skipping malformed log entry at ${logFile}:${i + 1}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return coalesceMessagingBotLogChunks(records);
}

function coalesceMessagingBotLogChunks(records: LogRecord[]): LogRecord[] {
  const coalesced: LogRecord[] = [];
  for (const record of records) {
    const previous = coalesced.at(-1);
    if (previous && canCoalesceMessagingBotLogChunk(previous.message, record.message)) {
      previous.message.text = `${previous.message.text ?? ""}${record.message.text ?? ""}`;
      continue;
    }
    coalesced.push({ ...record, message: { ...record.message } });
  }
  return coalesced;
}

function canCoalesceMessagingBotLogChunk(
  previous: ConversationLogMessage,
  current: ConversationLogMessage,
): boolean {
  return (
    previous.isMessagingBot === true &&
    current.isMessagingBot === true &&
    !!previous.ts &&
    previous.ts === current.ts &&
    previous.threadTs === current.threadTs &&
    previous.user === current.user
  );
}
