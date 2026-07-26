import type { SessionEntry, SessionStore } from "../harness/index.js";
import type { ConversationLogMessage } from "../types.js";
import { isRecord } from "../utils/file-guards.js";
import { isCommandText } from "../commands/text.js";
import { readConversationLog } from "./conversation-log.js";
import { formatHistoryLine, stripHistoryLinePrefix } from "./history-line.js";
import { isPlatformHistorySession } from "./metadata.js";
import { shouldRotateTopLevelSession } from "./rotation.js";
import { isThreadSessionKey } from "./session-key.js";
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
} from "./types.js";

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

/**
 * Syncs the platform chat transcript (log.jsonl) into managed session files:
 * resolves which session file a message belongs to (top-level vs thread,
 * with biweekly rotation), bootstraps new sessions from recent history, and
 * incrementally appends log messages the session does not yet represent.
 */
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
    const sessionDir = getChannelSessionDir(options.conversationDir);

    if (!isThreadSessionKey(options.sessionKey)) {
      const contextFile = this.resolveTopLevelSessionFile({
        conversationDir: options.conversationDir,
        sessionDir,
        cwd,
        currentMessageId: options.currentMessageId,
        rotateTopLevelSession: options.rotateTopLevelSession === true,
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

  syncSessionManager(options: SyncChatSessionOptions): ChatSyncReport {
    const records = readConversationLog(options.conversationDir);
    return syncSessionManagerFromLog(
      options.sessionManager,
      selectExistingSessionSyncMessages(records, {
        sessionKey: isThreadSessionKey(options.sessionKey) ? options.sessionKey : null,
        excludeMessageId: options.currentMessageId,
      }),
      this.historyWindow(),
    );
  }

  resetSession(options: ResetChatSessionOptions): string {
    const cwd = options.cwd ?? options.conversationDir;
    const sessionFile = isThreadSessionKey(options.sessionKey)
      ? createManagedSessionFileAtPath(
          getThreadSessionFile(options.conversationDir, options.sessionKey),
          cwd,
        )
      : createManagedSessionFile(getChannelSessionDir(options.conversationDir), cwd);
    const records = readConversationLog(options.conversationDir);
    const lastMessageId = latestSyncMessageId(records, {
      sessionKey: isThreadSessionKey(options.sessionKey) ? options.sessionKey : null,
    });
    if (lastMessageId) {
      openManagedSession(sessionFile, cwd).appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
        source: "log.jsonl",
        messageCount: 0,
        lastMessageId,
      });
    }
    return sessionFile;
  }

  private resolveTopLevelSessionFile(options: {
    conversationDir: string;
    sessionDir: string;
    cwd: string;
    currentMessageId?: string;
    rotateTopLevelSession: boolean;
  }): string {
    const records = readConversationLog(options.conversationDir);
    const existing = tryResolveCurrentSession(options.sessionDir);
    if (existing && !isPlatformHistorySession(existing)) {
      if (!options.rotateTopLevelSession || !shouldRotateTopLevelSession(existing, this.now())) {
        syncSessionFromLog(
          existing,
          options.cwd,
          selectExistingSessionSyncMessages(records, {
            sessionKey: null,
            excludeMessageId: options.currentMessageId,
          }),
          this.historyWindow(),
        );
        return existing;
      }
    }

    const sessionFile = createManagedSessionFile(options.sessionDir, options.cwd);
    const bootstrapRecords = selectRecentTopLevelMessages(records, {
      recentDays: this.recentDays,
      maxMessages: this.maxTopLevelMessages,
      now: this.now(),
      excludeMessageId: options.currentMessageId,
    });
    bootstrapSessionFromLog(
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

  private historyWindow(): HistoryWindow {
    return { recentDays: this.recentDays, maxMessages: this.maxTopLevelMessages, now: this.now() };
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
        options.cwd,
        selectExistingSessionSyncMessages(records, {
          sessionKey: options.sessionKey,
          excludeMessageId: options.currentMessageId,
        }),
        this.historyWindow(),
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
    bootstrapSessionFromLog(
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
  return selectRecentMessages(
    records.filter((record) => isTopLevelHistoryMessage(record.message, options.excludeMessageId)),
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
    records.filter((record) => {
      if (!isRenderableConversationMessage(record.message, options.excludeMessageId)) return false;
      if (!threadId) return !record.message.threadTs;
      return record.message.ts === threadId || record.message.threadTs === threadId;
    }),
  );
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
  if (isChatCommandMessage(message)) return false;
  return !!message.text?.trim();
}

function isChatCommandMessage(message: ConversationLogMessage): boolean {
  return !message.isMessagingBot && isCommandText(message.text ?? "");
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
  cwd: string,
  records: LogRecord[],
  lastMessageId = records.at(-1)?.message.ts,
): void {
  if (records.length === 0 && !lastMessageId) return;

  const sessionManager = openManagedSession(sessionFile, cwd);
  appendLogRecordsToSession(sessionManager, records);
  sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
    source: "log.jsonl",
    messageCount: records.length,
    lastMessageId,
  });
}

interface HistoryWindow {
  recentDays: number;
  maxMessages: number;
  now: Date;
}

function syncSessionFromLog(
  sessionFile: string,
  cwd: string,
  records: LogRecord[],
  historyWindow: HistoryWindow,
): ChatSyncReport {
  if (records.length === 0) return { appended: 0 };
  return syncSessionManagerFromLog(openManagedSession(sessionFile, cwd), records, historyWindow);
}

function syncSessionManagerFromLog(
  sessionManager: SessionStore,
  records: LogRecord[],
  historyWindow: HistoryWindow,
): ChatSyncReport {
  if (records.length === 0) return { appended: 0 };

  const existingEntries = sessionManager.getEntries();
  const lastSyncedMessageId = getLatestChatSyncMessageId(existingEntries);
  const lastSyncedIndex = lastSyncedMessageId
    ? records.findIndex((record) => record.message.ts === lastSyncedMessageId)
    : -1;
  if (lastSyncedMessageId && lastSyncedIndex === -1) return { appended: 0 };

  const syncCandidates = selectRecentMessages(records.slice(lastSyncedIndex + 1), historyWindow);
  if (syncCandidates.length === 0) return { appended: 0 };

  const represented = buildRepresentedMessageCounts(existingEntries);
  const newRecords = syncCandidates.filter(
    (record) => !consumeRepresentedLogMessage(record, represented),
  );
  if (newRecords.length === 0) return { appended: 0 };

  const lastMessageId = syncCandidates.at(-1)?.message.ts;
  appendLogRecordsToSession(sessionManager, newRecords);
  sessionManager.appendCustomEntry(CHAT_SYNC_CUSTOM_TYPE, {
    source: "log.jsonl",
    messageCount: newRecords.length,
    lastMessageId,
  });
  return {
    appended: newRecords.length,
    ...(lastMessageId !== undefined ? { lastMessageId } : {}),
  };
}

function appendLogRecordsToSession(sessionManager: SessionStore, records: LogRecord[]): void {
  for (const record of records) {
    const message = buildHistorySessionMessage(record.message);
    if (message) sessionManager.appendMessage(message);
  }
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
