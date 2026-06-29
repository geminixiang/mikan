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

// ── chat session manager ─────────────────────────────────────────────────────

export interface AgentMemoryFileManagerOptions {
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
  /** Rotate top-level shared sessions on biweekly Sunday boundaries. */
  rotateTopLevelSession?: boolean;
}

export interface SyncAgentMemoryFileManagerOptions {
  conversationDir: string;
  sessionKey: string;
  sessionManager: import("../harness/session-manager.js").SessionManager;
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
