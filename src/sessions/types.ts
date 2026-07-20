import type { ConversationKind, PlatformName } from "../adapter.js";

export interface ConversationStorageScope {
  /** Platform namespace, normalized to a stable lowercase identity segment. */
  platform: PlatformName;
  /** Opaque platform-issued address; remains unchanged at platform interfaces. */
  conversationId: string;
  /** Flat workspace child name used for all conversation-owned storage. */
  storageKey: string;
}

export interface ConversationSessionIdentity {
  /** Existing platform/log/session-store key; preserves the wire conversation prefix. */
  platformSessionKey: string;
  /** Process/runtime key; replaces the prefix with the conversation storage key. */
  runtimeSessionKey: string;
  /** Opaque thread/reply suffix, or null for the persistent top-level session. */
  suffix: string | null;
}

export interface ConversationStorageCatalogEntry extends ConversationStorageScope {
  conversationDir: string;
}

export interface ConversationStorageOwnershipManifest {
  version: 1;
  /** Explicit assertion that this manifest is the complete legacy ownership inventory. */
  complete: boolean;
  owners: Record<string, PlatformName>;
}

export interface ConversationStorageCompletionRecord {
  version: 1;
  workspaceRoot: string;
  manifestDigest: string;
  completedAt: string;
}

export interface ConversationStorageMigrationResult {
  conversationId: string;
  platform: PlatformName;
  storageKey: string;
  conversationDir: string;
  migratedLegacy: boolean;
}

export interface ConversationStorageManagerOptions {
  workspaceRoot: string;
  activePlatforms: readonly PlatformName[];
  /** Strictly fence the pre-namespace runtime/placement before migration publishes. */
  fenceLegacyAuthority?: (platform: PlatformName, conversationId: string) => Promise<void>;
}

export interface ResolveConversationStorageOptions {
  workspaceRoot: string;
  platform: PlatformName;
  conversationId: string;
  /** Platforms enabled by this coordinator; legacy ownership is ambiguous when more than one is active. */
  activePlatforms: readonly PlatformName[];
  /**
   * Called after durable owner reservation but before a legacy directory is
   * published under its scoped key. Remote Gondolin supplies strict legacy
   * instance fencing here; rejection leaves the migration unpublished.
   */
  fenceLegacyAuthority?: () => Promise<void>;
}

export interface ResolvedConversationStorage extends ConversationStorageScope {
  conversationDir: string;
  /** True only when this call atomically moved a legacy unscoped directory. */
  migratedLegacy: boolean;
}

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

// ── chat history sync ────────────────────────────────────────────────────────

export interface ChatHistorySyncOptions {
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

export interface SyncChatSessionOptions {
  conversationDir: string;
  sessionKey: string;
  sessionManager: import("../harness/index.js").SessionStore;
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
