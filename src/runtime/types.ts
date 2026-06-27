import type { PiAgentWrapper } from "../agent.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  ConversationKind,
} from "../adapter.js";
import type { CommandHandler, CommandServices } from "../commands/types.js";

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
}

export interface ConversationRuntime extends MessagingEventHandler {
  runSession(options: RunSessionOptions): Promise<void>;
  createSessionSandbox(options: CreateSessionSandboxOptions): Promise<PiAgentWrapper>;
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshConversationEnvironment(conversationId: string): boolean;
  shutdown(timeoutMs?: number): Promise<void>;
}
