import { join } from "path";
import { isRecord, parseJsonValue, readTextFileIfExists } from "./file-guards.js";
import * as log from "./log.js";

/**
 * Platform conversation history entry from log.jsonl.
 *
 * log.jsonl records what happened on the chat platform. sessions/*.jsonl are
 * LLM working contexts/records derived from platform messages and agent runs.
 */
export interface ConversationLogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  user?: string;
  userName?: string;
  text?: string;
  isBot?: boolean;
}

export async function findLogMessageById(
  conversationDir: string,
  messageId: string,
): Promise<ConversationLogMessage | null> {
  const logFile = join(conversationDir, "log.jsonl");
  const logContent = readTextFileIfExists(logFile);
  if (logContent === undefined) return null;
  const logLines = logContent.trim().split("\n").filter(Boolean);

  for (let i = logLines.length - 1; i >= 0; i--) {
    try {
      const entry = parseJsonValue(
        logLines[i],
        (value): value is ConversationLogMessage => isRecord(value),
        (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
      );
      if (entry.ts === messageId) {
        return entry;
      }
    } catch (err) {
      log.logWarning(
        `Skipping malformed log entry at ${logFile}:${i + 1}`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
  }

  return null;
}
