import type { Office } from "../office/types.js";
import type { ConversationKind } from "../types.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationLogMessage } from "../types.js";
import type { SessionStore } from "./session-store.js";

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

export type SessionRunStatus = "completed" | "aborted" | "failed";

export interface SessionRunRecord {
  startedAt: number;
  endedAt?: number;
  status?: SessionRunStatus;
}

export const CONTROL_INPUT_CUSTOM_TYPE = "mikan.control_input";

export interface SessionCreateInfo {
  id?: string;
  parentSessionId?: string;
  source?: { [key: string]: JsonValue };
}

export interface SessionInspection {
  getHeader(): SessionHeader;
  getEntries(): Promise<SessionEntry[]>;
  getSessionName(): Promise<string | undefined>;
  buildSessionContext(): Promise<SessionContext>;
}

export interface SessionHeader {
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  source?: { [key: string]: JsonValue };
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
