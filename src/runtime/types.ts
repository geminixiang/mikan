import type { PiAgentWrapper } from "../agent.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  ConversationKind,
  OfficeAddress,
  PlatformBlockKit,
  PlatformNotifier,
  PlatformReactor,
  PlatformUploader,
} from "../adapter.js";
import type {
  AdminTokenStoreLike,
  CommandHandler,
  CommandServices,
  LinkTokenStoreLike,
  SessionViewTokenStoreLike,
} from "../commands/types.js";
import type { MikanModels } from "../harness/index.js";
import type { PlatformToolPackFactory } from "../tools/types.js";
import type { VaultManager } from "../vault/index.js";

export interface SessionLifecycleOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  now?: () => number;
}

export interface ConversationRuntimeState {
  /** The office that owns this runtime state. */
  address: OfficeAddress;
  /** This office's platform session reference (raw session-key grammar). */
  sessionKey: string;
  running: boolean;
  /** Exact settlement of the current run, including post-run response handling. */
  runSettlement?: Promise<void>;
  runner: PiAgentWrapper;
  stopRequested: boolean;
  stopMessageTs?: string;
  lastAccessedAt: number;
  sessionFile: string;
  /** Epoch ms when the current run started; 0 when idle. */
  startedAt: number;
  lastActivityAt?: number;
}

export interface RunSessionOptions {
  event: ConversationEvent;
  bot: MessagingBot;
  context: ConversationContext;
}

/** Conversation/session identity used to resolve per-session runner state. */
export interface SessionStateOptions {
  /** Canonical office identity; the runtime keys all state by this. */
  address: OfficeAddress;
  /**
   * The office's raw platform id. Filesystem layout, settings, and Admin scope
   * still address offices this way; see ADR 0005.
   */
  conversationId: string;
  sessionKey: string;
  conversationKind?: ConversationKind;
}

export interface ConversationRuntimeOptions extends Omit<
  CommandServices,
  "runtime" | "vaultManager" | "linkTokenStore" | "sessionViewTokenStore" | "adminTokenStore"
> {
  /**
   * Credential vault for sandboxed conversations. Optional for embedders;
   * when omitted the runtime uses an inert, disabled vault.
   */
  vaultManager?: VaultManager;
  /** Login-portal token store; omit when no web portal is hosted. */
  linkTokenStore?: LinkTokenStoreLike;
  /** Session-viewer token store; omit when no web portal is hosted. */
  sessionViewTokenStore?: SessionViewTokenStoreLike;
  /** Admin-portal token store; omit when no web portal is hosted. */
  adminTokenStore?: AdminTokenStoreLike;
  /** Override the default command handlers (e.g., to add /help, /status). */
  commandHandlers?: readonly CommandHandler[];
  /** Model registry override; defaults to the process-wide models.json load. */
  models?: MikanModels;
  /** Proactive platform messaging for extensions (`api.notify`). */
  platformNotifier?: PlatformNotifier;
  /** Proactive emoji reactions for extensions (`api.react`). */
  platformReactor?: PlatformReactor;
  /** Proactive file uploads for extensions (`api.uploadFile`). */
  platformUploader?: PlatformUploader;
  /** Interactive Block Kit posting/updating for extensions (`api.blockkit`). */
  platformBlockKit?: PlatformBlockKit;
  /**
   * Optional platform capability packs (extra tools + per-run bind), as
   * factories — each runner instantiates its own pack because bind state is
   * per-runner. Assembled at process start (e.g. GitHub PR/CI pack); core
   * stays platform-neutral.
   */
  platformToolPackFactories?: readonly PlatformToolPackFactory[];
}

export interface ConversationRuntime extends MessagingEventHandler {
  runSession(options: RunSessionOptions): Promise<void>;
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshConversationEnvironment(conversationId: string): boolean;
  /** Clear idle runners; defer busy conversation invalidation until settlement. */
  refreshAllConversations(): { busy: string[] };
  shutdown(timeoutMs?: number): Promise<void>;
}
