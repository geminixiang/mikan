import type { ConversationKind } from "../types.js";
import type { AgentMessage, Entry, MessageEntry } from "@earendil-works/pi-agent-core";
import type { ConversationLogMessage } from "../types.js";
import type { SessionStore } from "./session-store.js";

// ── session metadata ─────────────────────────────────────────────────────────

export interface MikanSessionHeader {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  /** Legacy platform-history marker; preserved in mikan's durable session metadata. */
  source?: {
    kind?: string;
    file?: string;
    recentDays?: number;
  };
}

// ── session policy ───────────────────────────────────────────────────────────

export interface ResolveSessionKeyOptions {
  conversationId: string;
  conversationKind: ConversationKind;
  messageId: string;
  threadTs?: string;
  persistentTopLevel?: boolean;
  scopeDirectThreads?: boolean;
}

// ── session store ────────────────────────────────────────────────────────────

/** Model-visible messages reconstructed from the active session branch. */
export interface SessionContext {
  messages: AgentMessage[];
}

/** Message entry as stored in mikan session files (Pi v4). */
export type SessionMessageEntry = MessageEntry;

/** Union of entry types mikan reads and writes. Alias of Pi's v4 entry. */
export type SessionEntry = Entry;

export const CURRENT_SESSION_VERSION = 4;

export interface SessionCreateInfo {
  id?: string;
  parentSession?: string;
  parentSessionId?: string;
}

/** Immutable session queries available to portals, admin, and migration code. */
export interface SessionInspection {
  getHeader(): SessionHeader;
  getEntries(): Promise<Entry[]>;
  getSessionName(): Promise<string | undefined>;
  getBranch(fromId?: string): Promise<Entry[]>;
  buildSessionContext(): Promise<SessionContext>;
}

/**
 * Compatibility header view synthesized from the v4 file header for callers
 * that read mikan session lineage. `metadata` carries mikan header extras (for
 * example `parentSessionPath` and the legacy `source` marker preserved by
 * the v3 migration).
 */
export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  parentSessionId?: string;
  [extra: string]: unknown;
}

export interface ParentSessionRef {
  path: string;
  id: string;
}

export interface ThreadRootMessage {
  text?: string;
  userName?: string;
  user?: string;
  loggedAt?: number;
  isMessagingBot?: boolean;
}

export interface ResolvedSessionScope {
  sessionDir: string;
  contextFile: string;
  threadRootMessage: ThreadRootMessage | null;
}

/** One parsed log.jsonl entry with its original line index. */
export interface LogRecord {
  message: ConversationLogMessage;
  index: number;
}

// ── chat history sync ────────────────────────────────────────────────────────

/** What one sync pass actually did — the inspectable result of a sync. */
export interface ChatSyncReport {
  /** Log messages appended to the session in this pass. */
  appended: number;
  /** The log message id recorded as the new sync watermark. */
  lastMessageId?: string;
}

export interface ChatHistorySyncOptions {
  recentDays?: number;
  maxTopLevelMessages?: number;
  now?: () => Date;
}

export interface ResolveChatSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
  /** The triggering platform message ID. History is capped before this turn to avoid future queued turns. */
  currentMessageId?: string;
}

export interface SyncChatSessionOptions {
  conversationDir: string;
  sessionKey: string;
  sessionManager: SessionStore;
  /** The triggering platform message ID. Sync is capped before this turn to avoid future queued turns. */
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

// ── v3 migration ─────────────────────────────────────────────────────────────

export interface MigrateResult {
  file: string;
  status: "migrated" | "already-v4" | "skipped";
  detail?: string;
}

export interface Pi084MigrationResult {
  file: string;
  status: "migrated" | "already-current" | "not-pi-084";
  detail?: string;
}
