import type { ConversationKind, OfficeAddress } from "../adapter.js";
import type { SessionStore } from "../harness/index.js";
import type { ConversationLogMessage } from "../types.js";

// ── session metadata ─────────────────────────────────────────────────────────

export interface MikanSessionHeader {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  /** Legacy platform-history marker; preserved in v4 header metadata. */
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

export interface DurableSessionRef {
  id: string;
  file: string;
  /** Runtime serialization key compatible with this durable session. */
  sessionKey: string;
  current: boolean;
}

export interface DurableSessionTarget extends DurableSessionRef {
  address: OfficeAddress;
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
  /** Rotate top-level shared sessions on biweekly Sunday boundaries. */
  rotateTopLevelSession?: boolean;
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
