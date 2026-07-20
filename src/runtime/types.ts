import type { PiAgentWrapper } from "../agent.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  ConversationKind,
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

export interface RuntimeSessionIdentity {
  conversationId: string;
  platformSessionKey: string;
  runtimeSessionKey: string;
  storageKey: string;
  conversationDir: string;
}

export interface RuntimeShutdownOptions {
  shutdownHandler: () => Promise<void>;
  stopEvents: () => void;
  disconnectGondolinRuntimes: () => Promise<void>;
  flushTelemetry: () => Promise<unknown>;
  releaseGondolinCoordinator: () => void;
  exit: (code: number) => void;
}

export interface SessionLifecycleOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  now?: () => number;
}

export interface ConversationRuntimeState {
  running: boolean;
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
  /** Raw platform conversation address used for logs and platform replies. */
  conversationId: string;
  /** Existing persisted session key with the raw conversation prefix. */
  platformSessionKey: string;
  /** Storage-scoped key used only for process queues and runner state. */
  runtimeSessionKey: string;
  /** Platform-namespaced child identity under the workspace root. */
  storageKey: string;
  conversationDir: string;
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
  /** Clear every idle conversation's cached runners; report the busy ones. */
  refreshAllConversations(): { busy: string[] };
  shutdown(timeoutMs?: number): Promise<void>;
}
