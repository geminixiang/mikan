import type { Office } from "../office/types.js";
import type { ConversationKind } from "../types.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
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

interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface SessionCustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: JsonValue;
}

export interface SessionCompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId?: string;
}

export type SessionEntry = SessionMessageEntry | SessionCustomEntry | SessionCompactionEntry;

export interface SessionRunRecord {
  startedAt: number;
  endedAt?: number;
  status?: "completed" | "aborted" | "failed";
}

export const CURRENT_SESSION_VERSION = 5;

export const CONTROL_INPUT_CUSTOM_TYPE = "mikan.control_input";

export interface SessionCreateInfo {
  id?: string;
  parentSession?: string;
  parentSessionId?: string;
  source?: { [key: string]: JsonValue };
}

export interface SessionInspection {
  getHeader(): SessionHeader;
  getEntries(): Promise<SessionEntry[]>;
  getSessionName(): Promise<string | undefined>;
  getBranch(fromId?: string): Promise<SessionEntry[]>;
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
  office: Office;
  sessionKey: string;
  cwd?: string;
  currentMessageId?: string;
}

export interface SyncChatSessionOptions {
  office: Office;
  sessionKey: string;
  sessionManager: SessionStore;
  currentMessageId?: string;
}

export interface ResetChatSessionOptions {
  office: Office;
  sessionKey: string;
  cwd?: string;
}

export interface RegisterThreadSessionOptions {
  office: Office;
  sessionKey: string;
  cwd?: string;
}

export interface HasMaterializedSessionOptions {
  office: Office;
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
