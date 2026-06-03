import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import type { ConversationLogMessage } from "../context.js";
import { isRecord, parseJsonValue, readTextFileIfExists } from "../utils/file-guards.js";
import { formatLocalTimestamp } from "../utils/date.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";
import * as log from "../log.js";
import { isPlatformHistorySession } from "./metadata.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  extractSessionSuffix,
  getChannelSessionDir,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
  tryResolveCurrentSession,
  tryResolveThreadSession,
  type ResolvedSessionScope,
  type ThreadRootMessage,
} from "./store.js";

const DEFAULT_RECENT_DAYS = 14;
const DEFAULT_MAX_TOP_LEVEL_MESSAGES = 200;
const CHAT_SYNC_CUSTOM_TYPE = "mikan.chat_sync";

type SessionAppendMessage = Parameters<SessionManager["appendMessage"]>[0];

interface LogRecord {
  message: ConversationLogMessage;
  index: number;
}

export interface ChatSessionManagerOptions {
  recentDays?: number;
  maxTopLevelMessages?: number;
  now?: () => Date;
}

export interface ResolveChatSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
  /** The triggering platform message ID. Excluded from bootstrap to avoid duplicate user turns. */
  currentMessageId?: string;
}

export interface SyncChatSessionManagerOptions {
  conversationDir: string;
  sessionKey: string;
  sessionManager: SessionManager;
  /** The triggering platform message ID. Excluded from sync to avoid duplicate user turns. */
  currentMessageId?: string;
}

export interface ResetChatSessionOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
}

export interface RegisterThreadSessionOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
}

export interface HasMaterializedSessionOptions {
  conversationDir: string;
  sessionKey: string;
}

export interface ThreadBootstrapWaitOptions {
  parentSessionKey: string;
  sessionKey: string;
  hasThreadSession: () => boolean;
  isParentRunning: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export function hasMaterializedChatSession(options: HasMaterializedSessionOptions): boolean {
  if (!options.sessionKey.includes(":")) {
    return resolveChannelSessionFile(options.conversationDir) !== null;
  }
  return (
    tryResolveThreadSession(getThreadSessionFile(options.conversationDir, options.sessionKey)) !==
    null
  );
}

export function registerThreadSession(options: RegisterThreadSessionOptions): string | null {
  if (!options.sessionKey.includes(":")) return null;

  const threadFile = getThreadSessionFile(options.conversationDir, options.sessionKey);
  return (
    tryResolveThreadSession(threadFile) ??
    createManagedSessionFileAtPath(threadFile, options.cwd ?? options.conversationDir)
  );
}

export async function waitForThreadSessionBootstrap(
  options: ThreadBootstrapWaitOptions,
): Promise<boolean> {
  const {
    parentSessionKey,
    sessionKey,
    hasThreadSession,
    isParentRunning,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    pollMs = 100,
  } = options;

  if (!sessionKey.includes(":")) return false;
  if (sessionKey === parentSessionKey) return false;
  if (hasThreadSession()) return false;

  let waited = false;
  while (isParentRunning() && !hasThreadSession()) {
    waited = true;
    await sleep(pollMs);
  }

  return waited;
}

export class ChatSessionManager {
  private readonly recentDays: number;
  private readonly maxTopLevelMessages: number;
  private readonly now: () => Date;

  constructor(options: ChatSessionManagerOptions = {}) {
    this.recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;
    this.maxTopLevelMessages = options.maxTopLevelMessages ?? DEFAULT_MAX_TOP_LEVEL_MESSAGES;
    this.now = options.now ?? (() => new Date());
  }

  async resolveSessionScope(
    options: ResolveChatSessionScopeOptions,
  ): Promise<ResolvedSessionScope> {
    const cwd = options.cwd ?? options.conversationDir;
    const sessionDir = getChannelSessionDir(options.conversationDir);

    if (!options.sessionKey.includes(":")) {
      const contextFile = this.resolveTopLevelSessionFile({
        conversationDir: options.conversationDir,
        sessionDir,
        cwd,
        currentMessageId: options.currentMessageId,
      });
      return { sessionDir, contextFile, threadRootMessage: null };
    }

    return this.resolveThreadSessionScope({
      conversationDir: options.conversationDir,
      sessionDir,
      sessionKey: options.sessionKey,
      cwd,
      currentMessageId: options.currentMessageId,
    });
  }

  syncSessionManager(options: SyncChatSessionManagerOptions): void {
    const records = readConversationLog(options.conversationDir);
    syncSessionManagerFromLog(
      options.sessionManager,
      selectExistingSessionSyncMessages(records, {
        sessionKey: options.sessionKey.includes(":") ? options.sessionKey : null,
        excludeMessageId: options.currentMessageId,
      }),
    );
  }

  resetSession(options: ResetChatSessionOptions): string {
    const cwd = options.cwd ?? options.conversationDir;
    if (options.sessionKey.includes(":")) {
      return createManagedSessionFileAtPath(
        getThreadSessionFile(options.conversationDir, options.sessionKey),
        cwd,
      );
    }

    return createManagedSessionFile(getChannelSessionDir(options.conversationDir), cwd);
  }

  private resolveTopLevelSessionFile(options: {
    conversationDir: string;
    sessionDir: string;
    cwd: string;
    currentMessageId?: string;
  }): string {
    const records = readConversationLog(options.conversationDir);
    const existing = tryResolveCurrentSession(options.sessionDir);
    if (existing && !isPlatformHistorySession(existing)) {
      syncSessionFromLog(
        existing,
        options.sessionDir,
        options.cwd,
        selectExistingSessionSyncMessages(records, {
          sessionKey: null,
          excludeMessageId: options.currentMessageId,
        }),
      );
      return existing;
    }

    const sessionFile = createManagedSessionFile(options.sessionDir, options.cwd);
    const bootstrapRecords = selectRecentTopLevelMessages(records, {
      recentDays: this.recentDays,
      maxMessages: this.maxTopLevelMessages,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
    });
    bootstrapSessionFromLog(sessionFile, options.sessionDir, options.cwd, bootstrapRecords);
    return sessionFile;
  }

  private resolveThreadSessionScope(options: {
    conversationDir: string;
    sessionDir: string;
    sessionKey: string;
    cwd: string;
    currentMessageId?: string;
  }): ResolvedSessionScope {
    const threadFile = getThreadSessionFile(options.conversationDir, options.sessionKey);
    const threadId = extractSessionSuffix(options.sessionKey);
    const records = readConversationLog(options.conversationDir);
    const threadRootMessage = buildThreadRootSeed(findLogRecordById(records, threadId)?.message);
    const existing = tryResolveThreadSession(threadFile);
    if (existing) {
      syncSessionFromLog(
        existing,
        options.sessionDir,
        options.cwd,
        selectExistingSessionSyncMessages(records, {
          sessionKey: options.sessionKey,
          excludeMessageId: options.currentMessageId,
        }),
      );
      return { sessionDir: options.sessionDir, contextFile: existing, threadRootMessage };
    }

    createManagedSessionFileAtPath(threadFile, options.cwd);
    const bootstrapRecords = selectThreadBootstrapMessages(records, threadId, {
      recentDays: this.recentDays,
      maxTopLevelMessages: this.maxTopLevelMessages,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
    });
    bootstrapSessionFromLog(threadFile, options.sessionDir, options.cwd, bootstrapRecords);

    return { sessionDir: options.sessionDir, contextFile: threadFile, threadRootMessage };
  }
}

function readConversationLog(conversationDir: string): LogRecord[] {
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
  return records;
}

function findLogRecordById(records: LogRecord[], messageId: string): LogRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].message.ts === messageId) return records[i];
  }
  return undefined;
}

function selectRecentTopLevelMessages(
  records: LogRecord[],
  options: {
    recentDays: number;
    maxMessages: number;
    now: Date;
    excludeMessageId?: string;
  },
): LogRecord[] {
  const sinceMs = options.now.getTime() - options.recentDays * 24 * 60 * 60 * 1000;
  return records
    .filter((record) => isTopLevelHistoryMessage(record.message, sinceMs, options.excludeMessageId))
    .slice(-options.maxMessages);
}

function selectThreadBootstrapMessages(
  records: LogRecord[],
  threadId: string,
  options: {
    recentDays: number;
    maxTopLevelMessages: number;
    now: Date;
    excludeMessageId?: string;
  },
): LogRecord[] {
  const rootRecord = findLogRecordById(records, threadId);
  const topLevelSource = rootRecord
    ? records.filter((record) => record.index <= rootRecord.index)
    : records;
  const topLevelRecords = selectRecentTopLevelMessages(topLevelSource, {
    recentDays: options.recentDays,
    maxMessages: options.maxTopLevelMessages,
    now: options.now,
    excludeMessageId: options.excludeMessageId,
  });
  const threadRecords = records.filter(
    (record) =>
      isRenderableChatMessage(record.message, options.excludeMessageId) &&
      (record.message.ts === threadId || record.message.threadTs === threadId),
  );

  return dedupeAndSortRecords([...topLevelRecords, ...threadRecords]);
}

function isTopLevelHistoryMessage(
  message: ConversationLogMessage,
  sinceMs: number,
  excludeMessageId?: string,
): boolean {
  if (!isRenderableChatMessage(message, excludeMessageId)) return false;
  if (message.threadTs) return false;
  if (!message.date) return true;

  const dateMs = new Date(message.date).getTime();
  return !Number.isFinite(dateMs) || dateMs >= sinceMs;
}

function selectExistingSessionSyncMessages(
  records: LogRecord[],
  options: { sessionKey: string | null; excludeMessageId?: string },
): LogRecord[] {
  const threadId = options.sessionKey ? extractSessionSuffix(options.sessionKey) : null;
  return dedupeAndSortRecords(
    records.filter((record) => {
      if (!isRenderableChatMessage(record.message, options.excludeMessageId)) return false;
      if (!threadId) return !record.message.threadTs;
      return record.message.ts === threadId || record.message.threadTs === threadId;
    }),
  );
}

function isRenderableChatMessage(
  message: ConversationLogMessage,
  excludeMessageId?: string,
): boolean {
  if (excludeMessageId && message.ts === excludeMessageId) return false;
  if (isChatCommandMessage(message)) return false;
  return !!message.text?.trim();
}

function isChatCommandMessage(message: ConversationLogMessage): boolean {
  const text = message.text?.trim() ?? "";
  return (
    !message.isBot &&
    /^\/(?:pi-[\w-]+|login|session|new|stop|model|sandbox|admin|auto-reply)(?:@\w+)?(?:\s|$)/i.test(
      text,
    )
  );
}

function dedupeAndSortRecords(records: LogRecord[]): LogRecord[] {
  const byKey = new Map<string, LogRecord>();
  for (const record of records) {
    byKey.set(record.message.ts ?? `line:${record.index}`, record);
  }

  return Array.from(byKey.values()).toSorted((a, b) => {
    const aTime = sortTime(a);
    const bTime = sortTime(b);
    if (aTime !== bTime) return aTime - bTime;
    return a.index - b.index;
  });
}

function sortTime(record: LogRecord): number {
  if (record.message.date) {
    const dateMs = new Date(record.message.date).getTime();
    if (Number.isFinite(dateMs)) return dateMs;
  }

  if (record.message.ts) {
    const tsMs = Number(record.message.ts) * 1000;
    if (Number.isFinite(tsMs)) return tsMs;
  }

  return record.index;
}

function bootstrapSessionFromLog(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  records: LogRecord[],
): void {
  if (records.length === 0) return;

  const sessionManager = openManagedSession(sessionFile, sessionDir, cwd);
  appendLogRecordsToSession(sessionManager, records);
  sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
    source: "log.jsonl",
    messageCount: records.length,
    lastMessageId: records.at(-1)?.message.ts,
  });
  forceRewriteSession(sessionManager, sessionFile);
}

function syncSessionFromLog(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
  records: LogRecord[],
): void {
  if (records.length === 0) return;
  syncSessionManagerFromLog(openManagedSession(sessionFile, sessionDir, cwd), records);
}

function syncSessionManagerFromLog(sessionManager: SessionManager, records: LogRecord[]): void {
  if (records.length === 0) return;

  const existingEntries = sessionManager.getEntries();
  const lastSyncedMessageId = getLatestChatSyncMessageId(existingEntries);
  const startIndex = lastSyncedMessageId
    ? records.findIndex((record) => record.message.ts === lastSyncedMessageId) + 1
    : 0;
  const syncCandidates = records.slice(Math.max(startIndex, 0));
  if (syncCandidates.length === 0) return;

  const represented = buildRepresentedMessageCounts(existingEntries);
  const newRecords = syncCandidates.filter(
    (record) => !consumeRepresentedLogMessage(record, represented),
  );
  if (newRecords.length === 0) return;

  appendLogRecordsToSession(sessionManager, newRecords);
  sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
    source: "log.jsonl",
    messageCount: newRecords.length,
    lastMessageId: syncCandidates.at(-1)?.message.ts,
  });
}

function appendLogRecordsToSession(sessionManager: SessionManager, records: LogRecord[]): void {
  for (const record of records) {
    const message = buildHistorySessionMessage(record.message);
    if (message) sessionManager.appendMessage(message);
  }
}

function forceRewriteSession(sessionManager: SessionManager, sessionFile: string): void {
  const header = sessionManager.getHeader();
  if (!header) return;

  const content = [header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  atomicWritePrivateFile(sessionFile, `${content}\n`);
}

function getLatestChatSyncMessageId(entries: SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== CHAT_SYNC_CUSTOM_TYPE) continue;
    if (!isRecord(entry.data)) return undefined;
    return typeof entry.data.lastMessageId === "string" ? entry.data.lastMessageId : undefined;
  }
  return undefined;
}

function buildRepresentedMessageCounts(entries: SessionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const comparable = comparableSessionMessage(entry);
    if (!comparable) continue;
    counts.set(comparable, (counts.get(comparable) ?? 0) + 1);
  }
  return counts;
}

function consumeRepresentedLogMessage(record: LogRecord, counts: Map<string, number>): boolean {
  const comparable = comparableLogMessage(record.message);
  if (!comparable) return false;

  const count = counts.get(comparable) ?? 0;
  if (count <= 0) return false;
  counts.set(comparable, count - 1);
  return true;
}

function comparableSessionMessage(entry: SessionEntry): string | null {
  if (entry.type !== "message") return null;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return null;

  const text = normalizeComparableText(getSessionMessageText(entry));
  if (!text) return null;
  return `${role}:${text}`;
}

function comparableLogMessage(message: ConversationLogMessage): string | null {
  const text = message.text?.trim();
  if (!text) return null;
  return `${message.isBot ? "assistant" : "user"}:${normalizeComparableText(text)}`;
}

function getSessionMessageText(entry: SessionEntry): string {
  if (entry.type !== "message" || !("content" in entry.message)) return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" && "text" in part ? part.text : ""))
    .join("\n");
}

function normalizeComparableText(text: string): string {
  return text
    .replace(
      /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}\]\s+\[[^\]]+\](?:\s+\[in-thread:[^\]]+\])?:\s*/,
      "",
    )
    .trim();
}

function buildHistorySessionMessage(message: ConversationLogMessage): SessionAppendMessage | null {
  const text = message.text?.trim();
  if (!text) return null;

  const timestamp = parseMessageTimestamp(message);
  if (!message.isBot) {
    return {
      role: "user",
      content: [{ type: "text", text: formatHistoryMessage(message) }],
      ...(timestamp !== undefined ? { timestamp } : {}),
    } as SessionAppendMessage;
  }

  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "platform-history",
    provider: "platform-history",
    model: "platform-history",
    usage: zeroUsage(),
    stopReason: "stop",
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as SessionAppendMessage;
}

function buildThreadRootSeed(
  message: ConversationLogMessage | undefined,
): ThreadRootMessage | null {
  if (!message) return null;
  return {
    text: message.text,
    userName: message.userName,
    user: message.user,
    loggedAt: message.date ? new Date(message.date).getTime() : undefined,
    isBot: message.isBot,
  };
}

function parseMessageTimestamp(message: ConversationLogMessage): number | undefined {
  if (message.date) {
    const dateMs = new Date(message.date).getTime();
    if (Number.isFinite(dateMs)) return dateMs;
  }

  if (message.ts) {
    const tsMs = Number(message.ts) * 1000;
    if (Number.isFinite(tsMs)) return tsMs;
  }

  return undefined;
}

function formatHistoryMessage(message: ConversationLogMessage): string {
  const text = message.text?.trim() ?? "";
  const userLabel = message.userName || message.user || "unknown";
  const timestamp = message.date ? formatLocalTimestamp(new Date(message.date)) : null;
  return timestamp ? `[${timestamp}] [${userLabel}]: ${text}` : `[${userLabel}]: ${text}`;
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
