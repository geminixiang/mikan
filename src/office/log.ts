import {
  appendFileNoFollow,
  parseJsonValue,
  readTextFileNoFollowIfExists,
} from "../file-guards.js";
import * as log from "../log.js";
import type { ConversationLogMessage, PlatformName, RunAnswer } from "../types.js";
import { errorMessage, isRecord } from "../unknown-values.js";
import type { Office } from "./types.js";

export interface BotResponseLogEntry {
  text: string;
  ts: string;
  threadTs?: string;
  answer?: RunAnswer;
  platform?: PlatformName;
  slackBlocks?: object[];
}

export function appendOfficeLog(office: Office, entry: ConversationLogMessage): void {
  office.ensure();
  appendFileNoFollow(office.logPath, `${JSON.stringify(entry)}\n`);
}

export function appendBotResponseLog(office: Office, response: BotResponseLogEntry): void {
  const { text, ts, threadTs, answer, platform, slackBlocks } = response;
  appendOfficeLog(office, {
    date: new Date().toISOString(),
    ts,
    threadTs: threadTs || undefined,
    user: "bot",
    text,
    attachments: [],
    isMessagingBot: true,
    platform,
    slackBlocks,
    ...answer,
  });
}

export function readOfficeLog(office: Pick<Office, "logPath">): ConversationLogMessage[] {
  const raw = readTextFileNoFollowIfExists(office.logPath);
  if (raw === undefined) return [];
  const entries: ConversationLogMessage[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = parseLogLine(line, office.logPath, index + 1);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseLogLine(
  line: string,
  logPath: string,
  lineNumber: number,
): ConversationLogMessage | undefined {
  try {
    return parseJsonValue(
      line,
      (value): value is ConversationLogMessage => isRecord(value),
      (detail, kind) => (kind === "shape" ? "expected a JSON object" : detail),
    );
  } catch (err) {
    log.logWarning(`Skipping malformed log entry at ${logPath}:${lineNumber}`, errorMessage(err));
    return undefined;
  }
}
