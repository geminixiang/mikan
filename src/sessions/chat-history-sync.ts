import { CONTROL_INPUT_CUSTOM_TYPE, type SessionEntry } from "./types.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "./session-store.js";
import type { ConversationLogMessage } from "../types.js";
import * as log from "../log.js";
import { parseJsonValue, readTextFileNoFollowIfExists } from "../file-guards.js";
import {
  formatHistoryLine,
  stripHistoryLinePrefix,
  stripTriggerSignature,
} from "./history-line.js";
import { extractSessionSuffix, isThreadSessionKey } from "./session-key.js";

const DEFAULT_RECENT_DAYS = 14;
const DEFAULT_MAX_TOP_LEVEL_MESSAGES = 200;
const THREAD_SEED_TOP_LEVEL_MESSAGES = 10;
const CHAT_SYNC_CUSTOM_TYPE = "mikan.chat_sync";

type SessionAppendMessage = Parameters<SessionStore["appendMessage"]>[0];

import type {
  ChatHistorySyncOptions,
  HasMaterializedSessionOptions,
  RegisterThreadSessionOptions,
  ResetChatSessionOptions,
  ResolveChatSessionScopeOptions,
  SyncChatSessionOptions,
  ThreadBootstrapWaitOptions,
  LogRecord,
  ResolvedSessionScope,
  ThreadRootMessage,
} from "./types.js";
import { errorMessage, isRecord } from "../unknown-values.js";

export async function hasMaterializedChatSession(
  options: HasMaterializedSessionOptions,
): Promise<boolean> {
  return SessionStore.exists(options.office, options.sessionKey);
}

export async function registerThreadSession(options: RegisterThreadSessionOptions): Promise<void> {
  if (!isThreadSessionKey(options.sessionKey)) return;
  const store = await SessionStore.open(options.office, options.sessionKey);
  await store.close();
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
  if (await hasThreadSession()) return false;

  let waited = false;
  while (isParentRunning() && !(await hasThreadSession())) {
    waited = true;
    await sleep(pollMs);
  }

  return waited;
}

export class ChatHistorySync {
  private readonly recentDays: number;
  private readonly maxTopLevelMessages: number;
  private readonly now: () => Date;
  private readonly isCommandText: (text: string) => boolean;

  constructor(options: ChatHistorySyncOptions) {
    this.isCommandText = options.isCommandText;
    this.recentDays = options.recentDays ?? DEFAULT_RECENT_DAYS;
    this.maxTopLevelMessages = options.maxTopLevelMessages ?? DEFAULT_MAX_TOP_LEVEL_MESSAGES;
    this.now = options.now ?? (() => new Date());
  }

  async resolveSessionScope(
    options: ResolveChatSessionScopeOptions,
  ): Promise<ResolvedSessionScope> {
    if (!isThreadSessionKey(options.sessionKey)) {
      await this.bootstrapTopLevelSession(options);
      return { threadRootMessage: null };
    }
    return this.resolveThreadSessionScope(options);
  }

  async syncSessionManager(options: SyncChatSessionOptions): Promise<void> {
    const records = readConversationLog(options.office);
    return syncSessionManagerFromLog(
      options.sessionManager,
      selectExistingSessionSyncMessages(records, {
        sessionKey: isThreadSessionKey(options.sessionKey) ? options.sessionKey : null,
        excludeMessageId: options.currentMessageId,
        isCommandText: this.isCommandText,
      }),
      {
        recentDays: this.recentDays,
        maxMessages: this.maxTopLevelMessages,
        now: this.now(),
      },
    );
  }

  async resetSession(options: ResetChatSessionOptions): Promise<void> {
    const records = readConversationLog(options.office);
    const lastMessageId = latestSyncMessageId(records, {
      sessionKey: isThreadSessionKey(options.sessionKey) ? options.sessionKey : null,
      isCommandText: this.isCommandText,
    });
    const sessionManager = await SessionStore.open(options.office, options.sessionKey);
    try {
      await sessionManager.reset();
      await sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
        resetAt: this.now().toISOString(),
        lastMessageId: lastMessageId ? lastMessageId : undefined,
      });
    } finally {
      await sessionManager.close();
    }
  }

  private async bootstrapTopLevelSession(options: ResolveChatSessionScopeOptions): Promise<void> {
    if (await SessionStore.exists(options.office, options.sessionKey)) return;
    const records = readConversationLog(options.office);
    const bootstrapRecords = selectRecentTopLevelMessages(records, {
      recentDays: this.recentDays,
      maxMessages: this.maxTopLevelMessages,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
      isCommandText: this.isCommandText,
    });
    await bootstrapSessionFromLog(
      options,
      bootstrapRecords,
      latestSyncMessageId(records, {
        sessionKey: null,
        excludeMessageId: options.currentMessageId,
        isCommandText: this.isCommandText,
      }),
    );
  }

  private async resolveThreadSessionScope(
    options: ResolveChatSessionScopeOptions,
  ): Promise<ResolvedSessionScope> {
    const threadId = extractSessionSuffix(options.sessionKey);
    const records = readConversationLog(options.office);
    const threadRootMessage = buildThreadRootSeed(findLogRecordById(records, threadId)?.message);
    if (await SessionStore.exists(options.office, options.sessionKey)) {
      return { threadRootMessage };
    }
    const bootstrapRecords = selectThreadBootstrapMessages(records, threadId, {
      recentDays: this.recentDays,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
      isCommandText: this.isCommandText,
    });
    await bootstrapSessionFromLog(
      options,
      bootstrapRecords,
      latestSyncMessageId(records, {
        sessionKey: options.sessionKey,
        excludeMessageId: options.currentMessageId,
        isCommandText: this.isCommandText,
      }),
    );
    return { threadRootMessage };
  }
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
    isCommandText: (text: string) => boolean;
  },
): LogRecord[] {
  return selectRecentMessages(
    recordsBeforeCurrentMessage(records, options.excludeMessageId).filter((record) =>
      isTopLevelHistoryMessage(record.message, options),
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
    now: Date;
    excludeMessageId?: string;
    isCommandText: (text: string) => boolean;
  },
): LogRecord[] {
  const scopedRecords = recordsBeforeCurrentMessage(records, options.excludeMessageId);
  const rootRecord = findLogRecordById(scopedRecords, threadId);
  const topLevelSource = rootRecord
    ? scopedRecords.filter((record) => record.index <= rootRecord.index)
    : scopedRecords;
  const topLevelRecords = selectRecentTopLevelMessages(topLevelSource, {
    recentDays: options.recentDays,
    maxMessages: THREAD_SEED_TOP_LEVEL_MESSAGES,
    now: options.now,
    excludeMessageId: options.excludeMessageId,
    isCommandText: options.isCommandText,
  });
  const threadRecords = scopedRecords.filter(
    (record) =>
      isRenderableConversationMessage(record.message, options) &&
      (record.message.ts === threadId || record.message.threadTs === threadId),
  );

  return dedupeAndSortRecords([...topLevelRecords, ...threadRecords]);
}

function isTopLevelHistoryMessage(
  message: ConversationLogMessage,
  filter: RenderableMessageFilter,
): boolean {
  if (!isRenderableConversationMessage(message, filter)) return false;
  return !message.threadTs;
}

function isRecentHistoryMessage(message: ConversationLogMessage, sinceMs: number): boolean {
  if (!message.date) return true;
  const dateMs = new Date(message.date).getTime();
  return !Number.isFinite(dateMs) || dateMs >= sinceMs;
}

function selectExistingSessionSyncMessages(
  records: LogRecord[],
  options: RenderableMessageFilter & { sessionKey: string | null },
): LogRecord[] {
  const threadId = options.sessionKey ? extractSessionSuffix(options.sessionKey) : null;
  return dedupeAndSortRecords(
    recordsBeforeCurrentMessage(records, options.excludeMessageId).filter((record) => {
      if (!isRenderableConversationMessage(record.message, options)) return false;
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
  options: RenderableMessageFilter & { sessionKey: string | null },
): string | undefined {
  return selectExistingSessionSyncMessages(records, options).at(-1)?.message.ts;
}

interface RenderableMessageFilter {
  excludeMessageId?: string;
  isCommandText: (text: string) => boolean;
}

function isRenderableConversationMessage(
  message: ConversationLogMessage,
  filter: RenderableMessageFilter,
): boolean {
  if (filter.excludeMessageId && message.ts === filter.excludeMessageId) return false;
  if (!message.isMessagingBot && filter.isCommandText(message.text ?? "")) return false;
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
  session: { office: Office; sessionKey: string },
  records: LogRecord[],
  lastMessageId = records.at(-1)?.message.ts,
): Promise<void> {
  const sessionManager = await SessionStore.open(session.office, session.sessionKey);
  try {
    await appendLogRecordsToSession(sessionManager, records);
    await sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
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
): Promise<void> {
  if (records.length === 0) return;

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
  if (syncCandidates.length === 0) return;

  const represented = buildRepresentedMessageCounts(existingEntries);
  const newRecords = syncCandidates.filter(
    (record) => !consumeRepresentedLogMessage(record, represented),
  );
  if (newRecords.length === 0) return;

  const lastMessageId = syncCandidates.at(-1)?.message.ts;
  await appendLogRecordsToSession(sessionManager, newRecords);
  await sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
    lastMessageId,
  });
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

  const key = counts.get(comparable) ? comparable : presentedAnswerKey(comparable, counts);
  if (!key) return false;
  counts.set(key, (counts.get(key) ?? 0) - 1);
  return true;
}

function presentedAnswerKey(comparable: string, counts: Map<string, number>): string | undefined {
  if (!comparable.startsWith(ASSISTANT_KEY_PREFIX)) return undefined;
  const posted = comparable.slice(ASSISTANT_KEY_PREFIX.length);
  for (const [key, count] of counts) {
    if (count <= 0 || !key.startsWith(ASSISTANT_KEY_PREFIX)) continue;
    const answer = key.slice(ASSISTANT_KEY_PREFIX.length);
    if (posted.endsWith(`\n\n${answer}`)) return key;
  }
  return undefined;
}

const ASSISTANT_KEY_PREFIX = "assistant:";

function comparableSessionMessage(entry: SessionEntry): string | null {
  if (entry.type !== "message") return null;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return null;

  const raw = getSessionMessageText(entry);
  const text = normalizeComparableText(role === "assistant" ? stripTriggerSignature(raw) : raw);
  if (!text) return null;
  return `${role}:${text}`;
}

function comparableLogMessage(message: ConversationLogMessage): string | null {
  const text = historyMessageText(message);
  if (!text) return null;
  return `${message.isMessagingBot ? "assistant" : "user"}:${normalizeComparableText(text)}`;
}

function historyMessageText(message: ConversationLogMessage): string {
  const text = message.text?.trim() ?? "";
  return message.isMessagingBot ? stripTriggerSignature(text) : text;
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
  const text = historyMessageText(message);
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

export function readConversationLog(office: Office): LogRecord[] {
  const logFile = office.logPath;
  const raw = readTextFileNoFollowIfExists(logFile);
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
