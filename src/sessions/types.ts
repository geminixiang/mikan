import type { ConversationKind } from "../adapter.js";

// ── session metadata ─────────────────────────────────────────────────────────

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

// ── session policy ───────────────────────────────────────────────────────────

export type ChatPlatform = "slack" | "telegram" | "discord" | string;

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
  isBot?: boolean;
}

export interface ResolvedSessionScope {
  sessionDir: string;
  contextFile: string;
  threadRootMessage: ThreadRootMessage | null;
}

// ── chat session manager ─────────────────────────────────────────────────────

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
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
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
