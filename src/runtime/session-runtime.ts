import type { Bot, BotAdapters, BotEvent, BotHandler, RunningSession } from "../adapter.js";
import { type AgentRunner, createRunner } from "../agent.js";
import { defaultCommandHandlers } from "../commands/index.js";
import type { CommandHandler, CommandServices } from "../commands/index.js";
import * as log from "../log.js";
import { reportUserFacingError } from "../sentry.js";
import {
  ChatSessionManager,
  type ResolveChatSessionScopeOptions,
} from "../sessions/chat-session-manager.js";
import type { ResolvedSessionScope } from "../sessions/store.js";
import { formatNothingRunning, formatStopping } from "../platform-messages.js";
import {
  ConversationOrchestrator,
  type ConversationRuntimeState,
} from "./conversation-orchestrator.js";
import * as Sentry from "@sentry/node";
import { join } from "path";
import { getUnresolvedSandboxPathContext } from "../agent.js";

type ConversationState = ConversationRuntimeState;

export interface RunSessionOptions {
  event: BotEvent;
  bot: Bot;
  adapters: BotAdapters;
}

export interface CreateSessionSandboxOptions {
  conversationId: string;
  sessionKey: string;
}

export interface SessionRuntimeOptions extends Omit<CommandServices, "runtime"> {
  /** Override the default command handlers (e.g., to add /help, /status). */
  commandHandlers?: readonly CommandHandler[];
}

export interface SessionRuntime extends BotHandler {
  runSession(options: RunSessionOptions): Promise<void>;
  createSessionSandbox(options: CreateSessionSandboxOptions): Promise<AgentRunner>;
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshConversationEnvironment(conversationId: string): boolean;
  shutdown(timeoutMs?: number): Promise<void>;
}

const MAX_SESSIONS = 500;
const IDLE_TIMEOUT_MS = 3_600_000;

function runtimeCwdForSandbox(
  sandbox: SessionRuntimeOptions["sandbox"],
  hostWorkspaceRoot: string,
  conversationId: string,
): string {
  const runtimeWorkspaceRoot = getUnresolvedSandboxPathContext(
    sandbox,
    hostWorkspaceRoot,
  ).runtimeWorkspaceRoot;
  return `${runtimeWorkspaceRoot.replace(/\/+$/, "")}/${conversationId}`;
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  return new MikanSessionRuntime(options);
}

class MikanSessionRuntime implements SessionRuntime {
  private readonly conversationStates = new Map<string, ConversationState>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly inFlightRuns = new Set<Promise<void>>();
  private readonly orchestrator: ConversationOrchestrator;
  private readonly chatSessionManager = new ChatSessionManager();
  private isShuttingDown = false;

  constructor(private readonly options: SessionRuntimeOptions) {
    const commandServices: CommandServices = { ...options, runtime: this };
    const commandHandlers = options.commandHandlers ?? defaultCommandHandlers();
    this.orchestrator = new ConversationOrchestrator({
      workingDir: options.workingDir,
      commandHandlers,
      commandServices,
      isShuttingDown: () => this.isShuttingDown,
      getState: (sessionKey) => this.conversationStates.get(sessionKey),
      getOrCreateState: (createOptions) => this.getOrCreateState(createOptions),
      hasMaterializedSession: ({ conversationDir, sessionKey }) =>
        this.chatSessionManager.hasMaterializedSession({ conversationDir, sessionKey }),
      beforeRunTracked: (runPromise) => {
        this.inFlightRuns.add(runPromise);
        Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size);
      },
      afterRunTracked: (runPromise) => {
        this.inFlightRuns.delete(runPromise);
      },
      onRunFinished: () => {
        Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size - 1);
        this.evictIdleSessions();
      },
    });
  }

  isRunning(sessionKey: string): boolean {
    const state = this.conversationStates.get(sessionKey);
    return !!state?.running;
  }

  getRunningSessions(): RunningSession[] {
    const sessions: RunningSession[] = [];
    for (const [sessionKey, state] of this.conversationStates) {
      if (state.running && state.startedAt) {
        const currentStep = state.runner.getCurrentStep();
        sessions.push({
          sessionKey,
          startedAt: state.startedAt,
          lastActivityAt: state.lastActivityAt,
          currentTool: currentStep?.label || currentStep?.toolName,
        });
      }
    }
    return sessions;
  }

  async handleStop(sessionKey: string, conversationId: string, bot: Bot): Promise<void> {
    const state = this.conversationStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
      const ts = await bot.postMessage(conversationId, formatStopping(bot));
      state.stopMessageTs = ts;
    } else {
      await bot.postMessage(conversationId, formatNothingRunning(bot));
    }
  }

  forceStop(sessionKey: string): void {
    const state = this.conversationStates.get(sessionKey);
    if (state?.running) {
      log.logInfo(`[Force Stop] Force stopping session: ${sessionKey}`);
      state.stopRequested = true;
      state.runner.abort();
      state.running = false;
    }
  }

  async handleNewCommand(sessionKey: string, conversationId: string, bot: Bot): Promise<void> {
    const state = this.conversationStates.get(sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
    }

    const conversationDir = join(this.options.workingDir, conversationId);
    const runtimeCwd = runtimeCwdForSandbox(
      this.options.sandbox,
      this.options.workingDir,
      conversationId,
    );
    this.chatSessionManager.resetSession({ conversationDir, sessionKey, cwd: runtimeCwd });

    this.conversationStates.delete(sessionKey);

    log.logInfo(`[${conversationId}] Session reset: ${sessionKey}`);
    await bot.postMessage(conversationId, "Conversation reset. Send a new message to start fresh.");
  }

  async handleEvent(event: BotEvent, bot: Bot, adapters: BotAdapters): Promise<void> {
    const sessionKey = event.sessionKey ?? `${event.conversationId}:${event.thread_ts ?? event.ts}`;
    const previous = this.sessionQueues.get(sessionKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.runSession({ event, bot, adapters }));
    this.sessionQueues.set(sessionKey, next);
    try {
      await next;
    } finally {
      if (this.sessionQueues.get(sessionKey) === next) {
        this.sessionQueues.delete(sessionKey);
      }
    }
  }

  async runSession({ event, bot, adapters }: RunSessionOptions): Promise<void> {
    await this.orchestrator.runSession({ event, bot, adapters });
  }

  async createSessionSandbox(options: CreateSessionSandboxOptions): Promise<AgentRunner> {
    const state = await this.getOrCreateState(options);
    return state.runner;
  }

  switchConversationModel(conversationId: string, _provider: string, _model: string): boolean {
    return this.clearConversationStates(
      conversationId,
      `[${conversationId}] Model switched; cleared cached session runners`,
    );
  }

  refreshConversationEnvironment(conversationId: string): boolean {
    return this.clearConversationStates(
      conversationId,
      `[${conversationId}] Environment refreshed; cleared cached session runners`,
    );
  }

  private isConversationSession(sessionKey: string, conversationId: string): boolean {
    return sessionKey === conversationId || sessionKey.startsWith(`${conversationId}:`);
  }

  private clearConversationStates(conversationId: string, message: string): boolean {
    for (const [sessionKey, state] of this.conversationStates) {
      if (this.isConversationSession(sessionKey, conversationId) && state.running) {
        return false;
      }
    }

    for (const sessionKey of Array.from(this.conversationStates.keys())) {
      if (this.isConversationSession(sessionKey, conversationId)) {
        this.conversationStates.delete(sessionKey);
      }
    }
    log.logInfo(message);
    return true;
  }

  private async getOrCreateState(
    options: CreateSessionSandboxOptions & { currentMessageId?: string },
  ): Promise<ConversationState> {
    const { conversationId, sessionKey, currentMessageId } = options;
    const existing = this.conversationStates.get(sessionKey);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    const conversationDir = join(this.options.workingDir, conversationId);
    const runtimeCwd = runtimeCwdForSandbox(
      this.options.sandbox,
      this.options.workingDir,
      conversationId,
    );
    const sessionScope = await this.resolveSessionScope({
      conversationDir,
      sessionKey,
      cwd: runtimeCwd,
      currentMessageId,
    });
    const state: ConversationState = {
      running: false,
      runner: await createRunner(
        this.options.sandbox,
        sessionKey,
        conversationId,
        conversationDir,
        this.options.workingDir,
        sessionScope,
        this.options.vaultManager,
        this.options.provisioner,
        {
          tokenStore: this.options.sessionViewTokenStore,
          portalBaseUrl: this.options.portalBaseUrl,
        },
      ),
      stopRequested: false,
      lastAccessedAt: Date.now(),
    };
    this.conversationStates.set(sessionKey, state);
    return state;
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    log.logInfo("Shutting down gracefully...");

    const timeout = Date.now() + timeoutMs;
    while (this.inFlightRuns.size > 0 && Date.now() < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.inFlightRuns.size > 0) {
      log.logWarning(`Forcing exit with ${this.inFlightRuns.size} runs still in progress`);
      reportUserFacingError(new Error("Shutdown forced with in-flight agent runs"), {
        domain: "mikan",
        surface: "shutdown",
        operation: "force_exit_with_inflight_runs",
        severity: "warning",
        context: { inFlightRuns: this.inFlightRuns.size, timeoutMs },
      });
    }
  }

  private async resolveSessionScope(
    options: ResolveChatSessionScopeOptions,
  ): Promise<ResolvedSessionScope> {
    return this.chatSessionManager.resolveSessionScope(options);
  }

  private evictIdleSessions(): void {
    const now = Date.now();

    for (const [key, state] of this.conversationStates) {
      if (!state.running && now - state.lastAccessedAt > IDLE_TIMEOUT_MS) {
        this.conversationStates.delete(key);
      }
    }

    if (this.conversationStates.size > MAX_SESSIONS) {
      const idleSessions: Array<{ key: string; lastAccessedAt: number }> = [];
      for (const [key, state] of this.conversationStates) {
        if (!state.running) {
          idleSessions.push({ key, lastAccessedAt: state.lastAccessedAt });
        }
      }

      idleSessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      const toEvict = this.conversationStates.size - MAX_SESSIONS;
      for (let i = 0; i < toEvict && i < idleSessions.length; i++) {
        this.conversationStates.delete(idleSessions[i].key);
      }
    }
  }
}
