import { CONTROL_INPUT_CUSTOM_TYPE, type SessionEntry } from "./types.js";
import { OFFICE_LOG_FILENAME, officeSessionsDir } from "../office/index.js";
import { SessionStore } from "./session-store.js";
import type { ConversationLogMessage } from "../types.js";
import { join } from "node:path";
import * as log from "../log.js";
import { parseJsonValue, readTextFileIfExists } from "../file-guards.js";
import { isCommandText } from "../adapters/commands/manifest.js";
import { formatHistoryLine, stripHistoryLinePrefix } from "./history-line.js";
import { isPlatformHistorySession } from "./store.js";
import { isThreadSessionKey } from "./session-key.js";
import {
  archiveManagedSessionFile,
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  extractSessionSuffix,
  getThreadSessionFile,
  openManagedSession,
  resolveChannelSessionFile,
  resolveParentSessionForThread,
  tryResolveCurrentSession,
  tryResolveThreadSession,
} from "./store.js";

const DEFAULT_RECENT_DAYS = 14;
const DEFAULT_MAX_TOP_LEVEL_MESSAGES = 200;
const CHAT_SYNC_CUSTOM_TYPE = "mikan.chat_sync";

type SessionAppendMessage = Parameters<SessionStore["appendMessage"]>[0];

export type {
  ChatHistorySyncOptions,
  HasMaterializedSessionOptions,
  RegisterThreadSessionOptions,
  ResetChatSessionOptions,
  ResolveChatSessionScopeOptions,
  SyncChatSessionOptions,
  ThreadBootstrapWaitOptions,
  ChatSyncReport,
} from "./types.js";
import type {
  ChatHistorySyncOptions,
  HasMaterializedSessionOptions,
  RegisterThreadSessionOptions,
  ResetChatSessionOptions,
  ResolveChatSessionScopeOptions,
  SyncChatSessionOptions,
  ThreadBootstrapWaitOptions,
  ChatSyncReport,
  LogRecord,
  ParentSessionRef,
  ResolvedSessionScope,
  ThreadRootMessage,
} from "./types.js";
import { errorMessage, isRecord } from "../unknown-values.js";

export function hasMaterializedChatSession(options: HasMaterializedSessionOptions): boolean {
  if (!isThreadSessionKey(options.sessionKey)) {
    return resolveChannelSessionFile(options.conversationDir) !== null;
  }
  return (
    tryResolveThreadSession(getThreadSessionFile(options.conversationDir, options.sessionKey)) !==
    null
  );
}

export function registerThreadSession(options: RegisterThreadSessionOptions): string | null {
  if (!isThreadSessionKey(options.sessionKey)) return null;

  const threadFile = getThreadSessionFile(options.conversationDir, options.sessionKey);
  return (
    tryResolveThreadSession(threadFile) ??
    createManagedSessionFileAtPath(
      threadFile,
      options.cwd ?? options.conversationDir,
      resolveParentSessionForThread(
        options.conversationDir,
        extractSessionSuffix(options.sessionKey),
      ) ?? undefined,
    )
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

  if (!isThreadSessionKey(sessionKey)) return false;
  if (sessionKey === parentSessionKey) return false;
  if (hasThreadSession()) return false;

  let waited = false;
  while (isParentRunning() && !hasThreadSession()) {
    waited = true;
    await sleep(pollMs);
  }

  return waited;
}

export class ChatHistorySync {
  private readonly recentDays: number;
  private readonly maxTopLevelMessages: number;
  private readonly now: () => Date;

  constructor(options: ChatHistorySyncOptions = {}) {
    this.recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;
    this.maxTopLevelMessages = options.maxTopLevelMessages ?? DEFAULT_MAX_TOP_LEVEL_MESSAGES;
    this.now = options.now ?? (() => new Date());
  }

  async resolveSessionScope(
    options: ResolveChatSessionScopeOptions,
  ): Promise<ResolvedSessionScope> {
    const cwd = options.cwd ?? options.conversationDir;
    const sessionDir = officeSessionsDir(options.conversationDir);

    if (!isThreadSessionKey(options.sessionKey)) {
      const contextFile = await this.resolveTopLevelSessionFile({
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

  async syncSessionManager(options: SyncChatSessionOptions): Promise<ChatSyncReport> {
    const records = readConversationLog(options.conversationDir);
    return syncSessionManagerFromLog(
      options.sessionManager,
      selectExistingSessionSyncMessages(records, {
        sessionKey: isThreadSessionKey(options.sessionKey) ? options.sessionKey : null,
        excludeMessageId: options.currentMessageId,
      }),
      {
        recentDays: this.recentDays,
        maxMessages: this.maxTopLevelMessages,
        now: this.now(),
      },
    );
  }

  async resetSession(options: ResetChatSessionOptions): Promise<string> {
    const cwd = options.cwd ?? options.conversationDir;
    const sessionFile = isThreadSessionKey(options.sessionKey)
      ? resetThreadSessionFile(options.conversationDir, options.sessionKey, cwd)
      : createManagedSessionFile(officeSessionsDir(options.conversationDir), cwd);
    const records = readConversationLog(options.conversationDir);
    const lastMessageId = latestSyncMessageId(records, {
      sessionKey: isThreadSessionKey(options.sessionKey) ? options.sessionKey : null,
    });
    const sessionManager = await openManagedSession(sessionFile, cwd);
    try {
      await sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
        source: OFFICE_LOG_FILENAME,
        messageCount: 0,
        resetAt: this.now().toISOString(),
        lastMessageId: lastMessageId ? lastMessageId : undefined,
      });
    } finally {
      await sessionManager.close();
    }
    return sessionFile;
  }

  private async resolveTopLevelSessionFile(options: {
    conversationDir: string;
    sessionDir: string;
    cwd: string;
    currentMessageId?: string;
  }): Promise<string> {
    const existing = tryResolveCurrentSession(options.sessionDir);
    if (existing && !isPlatformHistorySession(existing)) return existing;
    const records = readConversationLog(options.conversationDir);

    const sessionFile = createManagedSessionFile(options.sessionDir, options.cwd);
    const bootstrapRecords = selectRecentTopLevelMessages(records, {
      recentDays: this.recentDays,
      maxMessages: this.maxTopLevelMessages,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
    });
    await bootstrapSessionFromLog(
      sessionFile,
      options.cwd,
      bootstrapRecords,
      latestSyncMessageId(records, {
        sessionKey: null,
        excludeMessageId: options.currentMessageId,
      }),
    );
    return sessionFile;
  }

  private async resolveThreadSessionScope(options: {
    conversationDir: string;
    sessionDir: string;
    sessionKey: string;
    cwd: string;
    currentMessageId?: string;
  }): Promise<ResolvedSessionScope> {
    const threadFile = getThreadSessionFile(options.conversationDir, options.sessionKey);
    const threadId = extractSessionSuffix(options.sessionKey);
    const records = readConversationLog(options.conversationDir);
    const threadRootMessage = buildThreadRootSeed(findLogRecordById(records, threadId)?.message);
    const existing = tryResolveThreadSession(threadFile);
    if (existing) {
      return { sessionDir: options.sessionDir, contextFile: existing, threadRootMessage };
    }

    createManagedSessionFileAtPath(
      threadFile,
      options.cwd,
      resolveParentSessionForThread(options.conversationDir, threadId) ?? undefined,
    );
    const bootstrapRecords = selectThreadBootstrapMessages(records, threadId, {
      recentDays: this.recentDays,
      maxTopLevelMessages: this.maxTopLevelMessages,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
    });
    await bootstrapSessionFromLog(
      threadFile,
      options.cwd,
      bootstrapRecords,
      latestSyncMessageId(records, {
        sessionKey: options.sessionKey,
        excludeMessageId: options.currentMessageId,
      }),
    );

    return { sessionDir: options.sessionDir, contextFile: threadFile, threadRootMessage };
  }
}

function existingThreadParent(threadFile: string): ParentSessionRef | undefined {
  let header;
  try {
    header = SessionStore.readHeader(threadFile);
  } catch {
    return undefined;
  }
  const path = header?.parentSession;
  if (!header || !path) return undefined;
  const id = header.parentSessionId ?? readParentSessionId(path);
  return id ? { path, id } : undefined;
}

function readParentSessionId(parentPath: string): string | undefined {
  try {
    return SessionStore.readHeader(parentPath)?.id;
  } catch {
    return undefined;
  }
}

function resetThreadSessionFile(conversationDir: string, sessionKey: string, cwd: string): string {
  const threadFile = getThreadSessionFile(conversationDir, sessionKey);
  const parent =
    existingThreadParent(threadFile) ??
    resolveParentSessionForThread(conversationDir, extractSessionSuffix(sessionKey)) ??
    undefined;
  archiveManagedSessionFile(threadFile);
  return createManagedSessionFileAtPath(threadFile, cwd, parent);
}

function findLogRecordById(records: LogRecord[], messageId: string): LogRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.message.ts === messageId) return records[i];
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
  return selectRecentMessages(
    recordsBeforeCurrentMessage(records, options.excludeMessageId).filter((record) =>
      isTopLevelHistoryMessage(record.message, options.excludeMessageId),
    ),
    options,
  );
}

function selectRecentMessages(records: LogRecord[], options: HistoryWindow): LogRecord[] {
  const sinceMs = options.now.getTime() - options.recentDays * 24 * 60 * 60 * 1000;
  return records
    .filter((record) => isRecentHistoryMessage(record.message, sinceMs))
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
  const scopedRecords = recordsBeforeCurrentMessage(records, options.excludeMessageId);
  const rootRecord = findLogRecordById(scopedRecords, threadId);
  const topLevelSource = rootRecord
    ? scopedRecords.filter((record) => record.index <= rootRecord.index)
    : scopedRecords;
  const topLevelRecords = selectRecentTopLevelMessages(topLevelSource, {
    recentDays: options.recentDays,
    maxMessages: options.maxTopLevelMessages,
    now: options.now,
    excludeMessageId: options.excludeMessageId,
  });
  const threadRecords = scopedRecords.filter(
    (record) =>
      isRenderableConversationMessage(record.message, options.excludeMessageId) &&
      (record.message.ts === threadId || record.message.threadTs === threadId),
  );

  return dedupeAndSortRecords([...topLevelRecords, ...threadRecords]);
}

function isTopLevelHistoryMessage(
  message: ConversationLogMessage,
  excludeMessageId?: string,
): boolean {
  if (!isRenderableConversationMessage(message, excludeMessageId)) return false;
  return !message.threadTs;
}

function isRecentHistoryMessage(message: ConversationLogMessage, sinceMs: number): boolean {
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
    recordsBeforeCurrentMessage(records, options.excludeMessageId).filter((record) => {
      if (!isRenderableConversationMessage(record.message, options.excludeMessageId)) return false;
      if (!threadId) return !record.message.threadTs;
      return record.message.ts === threadId || record.message.threadTs === threadId;
    }),
  );
}

function recordsBeforeCurrentMessage(records: LogRecord[], currentMessageId?: string): LogRecord[] {
  if (!currentMessageId) return records;
  const currentRecord = findLogRecordById(records, currentMessageId);
  if (!currentRecord) return records;
  return records.filter((record) => record.index < currentRecord.index);
}

function latestSyncMessageId(
  records: LogRecord[],
  options: { sessionKey: string | null; excludeMessageId?: string },
): string | undefined {
  return selectExistingSessionSyncMessages(records, options).at(-1)?.message.ts;
}

function isRenderableConversationMessage(
  message: ConversationLogMessage,
  excludeMessageId?: string,
): boolean {
  if (excludeMessageId && message.ts === excludeMessageId) return false;
  if (!message.isMessagingBot && isCommandText(message.text ?? "")) return false;
  return !!message.text?.trim();
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

async function bootstrapSessionFromLog(
  sessionFile: string,
  cwd: string,
  records: LogRecord[],
  lastMessageId = records.at(-1)?.message.ts,
): Promise<void> {
  if (records.length === 0 && !lastMessageId) return;

  const sessionManager = await openManagedSession(sessionFile, cwd);
  try {
    await appendLogRecordsToSession(sessionManager, records);
    await sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
      source: OFFICE_LOG_FILENAME,
      messageCount: records.length,
      lastMessageId,
    });
  } finally {
    await sessionManager.close();
  }
}

interface HistoryWindow {
  recentDays: number;
  maxMessages: number;
  now: Date;
}

async function syncSessionManagerFromLog(
  sessionManager: SessionStore,
  records: LogRecord[],
  historyWindow: HistoryWindow,
): Promise<ChatSyncReport> {
  if (records.length === 0) return { appended: 0 };

  const existingEntries = await sessionManager.getEntries();
  const resetAt = getLatestChatSyncResetAt(existingEntries);
  const controlledIds = new Set(
    existingEntries.flatMap((entry) => {
      if (
        entry.type !== "custom" ||
        entry.customType !== CONTROL_INPUT_CUSTOM_TYPE ||
        !isRecord(entry.data)
      )
        return [];
      return typeof entry.data.messageId === "string" ? [entry.data.messageId] : [];
    }),
  );
  const eligibleRecords = records.filter(
    (record) =>
      !controlledIds.has(record.message.ts ?? "") && (!resetAt || isAfterReset(record, resetAt)),
  );
  const lastSyncedMessageId = getLatestChatSyncMessageId(existingEntries);
  const lastSyncedIndex = lastSyncedMessageId
    ? eligibleRecords.findIndex((record) => record.message.ts === lastSyncedMessageId)
    : -1;
  const syncCandidates = selectRecentMessages(
    eligibleRecords.slice(lastSyncedIndex + 1),
    historyWindow,
  );
  if (syncCandidates.length === 0) return { appended: 0 };

  const represented = buildRepresentedMessageCounts(existingEntries);
  const newRecords = syncCandidates.filter(
    (record) => !consumeRepresentedLogMessage(record, represented),
  );
  if (newRecords.length === 0) return { appended: 0 };

  const lastMessageId = syncCandidates.at(-1)?.message.ts;
  await appendLogRecordsToSession(sessionManager, newRecords);
  await sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
    source: OFFICE_LOG_FILENAME,
    messageCount: newRecords.length,
    lastMessageId,
  });
  return {
    appended: newRecords.length,
    lastMessageId,
  };
}

async function appendLogRecordsToSession(
  sessionManager: SessionStore,
  records: LogRecord[],
): Promise<void> {
  for (const record of records) {
    const message = buildHistorySessionMessage(record.message);
    if (message) await sessionManager.appendMessage(message);
  }
}

function isChatSyncMarker(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
  return entry.type === "custom" && entry.customType === CHAT_SYNC_CUSTOM_TYPE;
}

function markerResetAt(entry: SessionEntry): number | undefined {
  if (!isChatSyncMarker(entry)) return undefined;
  if (!isRecord(entry.data) || typeof entry.data.resetAt !== "string") return undefined;
  const resetAt = new Date(entry.data.resetAt).getTime();
  return Number.isFinite(resetAt) ? resetAt : undefined;
}

function getLatestChatSyncResetAt(entries: SessionEntry[]): number | undefined {
  for (const entry of entries.toReversed()) {
    const resetAt = markerResetAt(entry);
    if (resetAt !== undefined) return resetAt;
  }
  return undefined;
}

function isAfterReset(record: LogRecord, resetAt: number): boolean {
  if (!record.message.date) return false;
  const messageTime = new Date(record.message.date).getTime();
  return Number.isFinite(messageTime) && messageTime >= resetAt;
}

function getLatestChatSyncMessageId(entries: SessionEntry[]): string | undefined {
  const marker = entries.toReversed().find(isChatSyncMarker);
  const lastMessageId = isRecord(marker?.data) ? marker.data.lastMessageId : undefined;
  return typeof lastMessageId === "string" ? lastMessageId : undefined;
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
  return `${message.isMessagingBot ? "assistant" : "user"}:${normalizeComparableText(text)}`;
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

const normalizeComparableText = stripHistoryLinePrefix;

function buildHistorySessionMessage(message: ConversationLogMessage): SessionAppendMessage | null {
  const text = message.text?.trim();
  if (!text) return null;

  const timestamp = parseMessageTimestamp(message);
  if (!message.isMessagingBot) {
    return {
      role: "user",
      content: [{ type: "text", text: formatHistoryMessage(message) }],
      timestamp,
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
    timestamp,
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
    isMessagingBot: message.isMessagingBot,
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
  return formatHistoryLine({
    date: message.date ? new Date(message.date) : undefined,
    userName: message.userName || message.user,
    text: message.text?.trim() ?? "",
  });
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

function readConversationLog(conversationDir: string): LogRecord[] {
  const logFile = join(conversationDir, OFFICE_LOG_FILENAME);
  const raw = readTextFileIfExists(logFile);
  if (raw === undefined) return [];

  const records: LogRecord[] = [];
  for (const [index, line] of raw.trim().split("\n").filter(Boolean).entries()) {
    const message = parseLogLine(line, logFile, index + 1);
    if (message) records.push({ message, index });
  }
  return coalesceMessagingBotLogChunks(records);
}

function parseLogLine(
  line: string,
  logFile: string,
  lineNumber: number,
): ConversationLogMessage | undefined {
  try {
    return parseJsonValue(
      line,
      (value): value is ConversationLogMessage => isRecord(value),
      (detail, kind) => (kind === "shape" ? "expected a JSON object" : detail),
    );
  } catch (err) {
    log.logWarning(`Skipping malformed log entry at ${logFile}:${lineNumber}`, errorMessage(err));
    return undefined;
  }
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
