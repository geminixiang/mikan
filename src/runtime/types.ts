import type { PiAgentWrapper } from "../agent.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  ConversationKind,
  PlatformNotifier,
  PlatformReactor,
} from "../adapter.js";
import type { CommandHandler, CommandServices } from "../commands/types.js";
import type { MikanModels } from "../harness/index.js";
import type { PlatformToolPackFactory } from "../tools/types.js";

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

export interface CreateSessionSandboxOptions {
  conversationId: string;
  sessionKey: string;
  conversationKind?: ConversationKind;
}

export interface ConversationRuntimeOptions extends Omit<CommandServices, "runtime"> {
  /** Override the default command handlers (e.g., to add /help, /status). */
  commandHandlers?: readonly CommandHandler[];
  /** Model registry override; defaults to the process-wide models.json load. */
  models?: MikanModels;
  /** Proactive platform messaging for extensions (`api.notify`). */
  platformNotifier?: PlatformNotifier;
  /** Proactive emoji reactions for extensions (`api.react`). */
  platformReactor?: PlatformReactor;
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
  createSessionSandbox(options: CreateSessionSandboxOptions): Promise<PiAgentWrapper>;
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshConversationEnvironment(conversationId: string): boolean;
  shutdown(timeoutMs?: number): Promise<void>;
}
