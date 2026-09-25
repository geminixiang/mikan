import type { ConversationKind } from "../types.js";
import type { AgentMessage, Entry, MessageEntry } from "@earendil-works/pi-agent-core";
import type { ConversationLogMessage } from "../types.js";
import type { SessionStore } from "./session-store.js";

export interface MikanSessionHeader {
  type?: string;
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
  source?: {
    kind?: string;
    file?: string;
    recentDays?: number;
  };
}

export interface ResolveSessionKeyOptions {
  conversationId: string;
  conversationKind: ConversationKind;
  messageId: string;
  threadTs?: string;
  persistentTopLevel?: boolean;
  scopeDirectThreads?: boolean;
}

export interface SessionContext {
  messages: AgentMessage[];
}

export type SessionMessageEntry = MessageEntry;

export type SessionEntry = Entry;

export const CURRENT_SESSION_VERSION = 4;

export const CONTROL_INPUT_CUSTOM_TYPE = "mikan.control_input";

export interface SessionCreateInfo {
  id?: string;
  parentSession?: string;
  parentSessionId?: string;
}

export interface SessionInspection {
  getHeader(): SessionHeader;
  getEntries(): Promise<Entry[]>;
  getSessionName(): Promise<string | undefined>;
  getBranch(fromId?: string): Promise<Entry[]>;
  buildSessionContext(): Promise<SessionContext>;
}

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

export interface LogRecord {
  message: ConversationLogMessage;
  index: number;
}

export interface ChatSyncReport {
  appended: number;
  lastMessageId?: string;
}

export interface ChatHistorySyncOptions {
  isCommandText: (text: string) => boolean;
  recentDays?: number;
  maxTopLevelMessages?: number;
  now?: () => Date;
}

export interface ResolveChatSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
  currentMessageId?: string;
}

export interface SyncChatSessionOptions {
  conversationDir: string;
  sessionKey: string;
  sessionManager: SessionStore;
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
