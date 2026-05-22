import { randomUUID } from "crypto";
import { mkdirSync, statSync } from "fs";
import { join } from "path";
import { isRecord, parseJsonValue, readTextFileIfExists } from "./file-guards.js";
import { atomicWritePrivateFile } from "./fs-atomic.js";
import type { ConversationLogMessage } from "./context.js";
import * as log from "./log.js";

export interface MaterializeTopLevelHistoryOptions {
  conversationDir: string;
  sessionDir: string;
  cwd: string;
  recentDays?: number;
  maxMessages?: number;
  now?: Date;
}

const DEFAULT_RECENT_DAYS = 14;
const DEFAULT_MAX_MESSAGES = 200;

export function resolveUsableTopLevelHistorySession(
  options: MaterializeTopLevelHistoryOptions & { existingSessionFile: string | null },
): string | null {
  if (options.existingSessionFile && isSessionFreshForTopLevelHistory(options)) {
    return options.existingSessionFile;
  }
  return materializeTopLevelHistorySession(options);
}

export function materializeTopLevelHistorySession(
  options: MaterializeTopLevelHistoryOptions,
): string | null {
  const messages = readTopLevelHistoryMessages(options);
  if (messages.length === 0) return null;

  mkdirSync(options.sessionDir, { recursive: true });
  const now = options.now ?? new Date();
  const sessionId = randomUUID();
  const filename = `${now.toISOString().replace(/[:.]/g, "-")}_${sessionId.slice(0, 8)}_history.jsonl`;
  const sessionFile = join(options.sessionDir, filename);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: now.toISOString(),
    cwd: options.cwd,
    source: {
      kind: "platform-history",
      file: "log.jsonl",
      recentDays: options.recentDays ?? DEFAULT_RECENT_DAYS,
    },
  };
  const entries = messages.map((message) => ({
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: new Date(message.date ?? now.toISOString()).toISOString(),
    message: buildHistorySessionMessage(message),
  }));

  const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
  atomicWritePrivateFile(sessionFile, `${content}\n`);
  atomicWritePrivateFile(join(options.sessionDir, "current"), filename);
  return sessionFile;
}

export function latestTopLevelHistoryTime(
  options: Omit<MaterializeTopLevelHistoryOptions, "sessionDir" | "cwd">,
): number | null {
  const messages = readTopLevelHistoryMessages({ ...options, maxMessages: 1 });
  const latest = messages.at(-1);
  if (!latest?.date) return null;
  const ms = new Date(latest.date).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function readTopLevelHistoryMessages(
  options: Omit<MaterializeTopLevelHistoryOptions, "sessionDir" | "cwd">,
): ConversationLogMessage[] {
  const logFile = join(options.conversationDir, "log.jsonl");
  const raw = readTextFileIfExists(logFile);
  if (raw === undefined) return [];

  const nowMs = (options.now ?? new Date()).getTime();
  const sinceMs = nowMs - (options.recentDays ?? DEFAULT_RECENT_DAYS) * 24 * 60 * 60 * 1000;
  const messages: ConversationLogMessage[] = [];
  const lines = raw.trim().split("\n").filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = parseJsonValue(
        lines[i],
        (value): value is ConversationLogMessage => isRecord(value),
        (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
      );
      if (entry.threadTs) continue;
      if (!entry.text?.trim()) continue;
      if (entry.date) {
        const dateMs = new Date(entry.date).getTime();
        if (Number.isFinite(dateMs) && dateMs < sinceMs) continue;
      }
      messages.push(entry);
    } catch (err) {
      log.logWarning(
        `Skipping malformed log entry at ${logFile}:${i + 1}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return messages.slice(-(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
}

function isSessionFreshForTopLevelHistory(
  options: MaterializeTopLevelHistoryOptions & { existingSessionFile: string | null },
): boolean {
  if (!options.existingSessionFile) return false;
  const latestHistoryMs = latestTopLevelHistoryTime(options);
  if (latestHistoryMs === null) return true;

  try {
    return statSync(options.existingSessionFile).mtimeMs >= latestHistoryMs;
  } catch {
    return false;
  }
}

function buildHistorySessionMessage(message: ConversationLogMessage): object {
  const base = {
    role: message.isBot ? "assistant" : "user",
    content: [{ type: "text", text: formatHistoryMessage(message) }],
    ...(message.date ? { timestamp: new Date(message.date).getTime() } : {}),
  };
  if (!message.isBot) return base;

  return {
    ...base,
    api: "platform-history",
    provider: "platform-history",
    model: "platform-history",
    usage: zeroUsage(),
    stopReason: "stop",
  };
}

function zeroUsage(): object {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function formatHistoryMessage(message: ConversationLogMessage): string {
  const text = message.text?.trim() ?? "";
  if (message.isBot) return text;
  const userLabel = message.userName || message.user || "unknown";
  const timestamp = message.date ? formatLocalTimestamp(new Date(message.date)) : null;
  return timestamp ? `[${timestamp}] [${userLabel}]: ${text}` : `[${userLabel}]: ${text}`;
}

function formatLocalTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
