import type { AgentRunner } from "../agent.js";
import type { Bot, BotAdapters, BotEvent, BotHandler, ConversationKind } from "../adapter.js";
import type { CommandServices } from "../commands/types.js";

export interface ConversationRuntimeState {
  running: boolean;
  runner: AgentRunner;
  stopRequested: boolean;
  stopMessageTs?: string;
  lastAccessedAt: number;
  sessionFile: string;
  /** Epoch ms when the current run started; 0 when idle. */
  startedAt: number;
  lastActivityAt?: number;
}

export interface RunSessionOptions {
  event: BotEvent;
  bot: Bot;
  adapters: BotAdapters;
}

export interface CreateSessionSandboxOptions {
  conversationId: string;
  sessionKey: string;
  conversationKind?: ConversationKind;
}

export interface SessionRuntimeOptions extends Omit<CommandServices, "runtime"> {
  /** Override the default command handlers (e.g., to add /help, /status). */
  commandHandlers?: readonly CommandHandler[];
}

import type { CommandHandler } from "../commands/types.js";

export interface SessionRuntime extends BotHandler {
  runSession(options: RunSessionOptions): Promise<void>;
  createSessionSandbox(options: CreateSessionSandboxOptions): Promise<AgentRunner>;
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshConversationEnvironment(conversationId: string): boolean;
  shutdown(timeoutMs?: number): Promise<void>;
}
