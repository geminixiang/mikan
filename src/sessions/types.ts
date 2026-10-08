import type { Office } from "../office/types.js";
import type { ConversationKind } from "../types.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Models } from "@earendil-works/pi-ai";
import type {
  Conversation,
  Harness,
  HarnessOptions,
  HarnessSettings,
  Registry,
} from "@earendil-works/pi-durable";
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

export interface SessionHarnessBinding {
  models: Models;
  requestModels?: Models;
  env?: HarnessOptions["env"];
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
}

export interface AttachedSessionHarness {
  harness: Harness;
  conversation: Conversation;
  registry: Registry;
  extensionName: string;
}

export interface SessionContext {
  messages: AgentMessage[];
}

interface SessionEntryBase {
  id: string;
  timestamp: number;
}

export interface ChatHistoryMessageIdentity {
  messageId: string | null;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
  history?: ChatHistoryMessageIdentity;
}

interface SessionCustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: JsonValue;
}

export interface SessionCompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
}

export type SessionEntry = SessionMessageEntry | SessionCustomEntry | SessionCompactionEntry;

export type SessionRunStatus = "completed" | "aborted" | "failed";

export interface SessionRunRecord {
  startedAt?: number;
  endedAt?: number;
  status?: SessionRunStatus;
}

export const CONTROL_INPUT_CUSTOM_TYPE = "mikan.control_input";
export const RUN_CAUSE_CUSTOM_TYPE = "mikan.run_cause";

export interface SessionInspection {
  getHeader(): SessionHeader;
  getEntries(): Promise<SessionEntry[]>;
  getSessionName(): Promise<string | undefined>;
  buildSessionContext(): Promise<SessionContext>;
}

export interface SessionHeader {
  id: string;
  createdAt: number;
  parentSessionId?: string;
}

export interface ThreadRootMessage {
  text?: string;
  userName?: string;
  user?: string;
}

export interface ResolvedSessionScope {
  threadRootMessage: ThreadRootMessage | null;
}

export interface SessionListing {
  key: string;
  id: string;
  createdAt: number;
  root: boolean;
  parentSessionId: string | undefined;
  forkEntryId: string | undefined;
}

export type ImportedSessionEntry =
  | { type: "message"; message: Message; history?: ChatHistoryMessageIdentity }
  | { type: "compaction"; summary: string; timestamp: number }
  | { type: "custom"; customType: string; data: unknown; timestamp: number };

export interface ImportedSession {
  key: string;
  id: string;
  createdAt: number;
  root: boolean;
  name: string | undefined;
  entries: ImportedSessionEntry[];
}

export interface LogRecord {
  message: ConversationLogMessage;
  index: number;
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
}

export interface RegisterThreadSessionOptions {
  office: Office;
  sessionKey: string;
}

export interface HasMaterializedSessionOptions {
  office: Office;
  sessionKey: string;
}

export interface ThreadBootstrapWaitOptions {
  parentSessionKey: string;
  sessionKey: string;
  hasThreadSession: () => Promise<boolean>;
  isParentRunning: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}
