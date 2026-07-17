import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  PlatformName,
  RunningSession,
} from "../adapter.js";
import { createRunner } from "../agent.js";
import { defaultCommandHandlers, dispatchCommand } from "../commands/registry.js";
import type { CommandHandler, CommandServices } from "../commands/types.js";
import { isPrivateConversation } from "../commands/utils.js";
import * as log from "../log.js";
import {
  addLifecycleBreadcrumb,
  applyRunScope,
  createRunAttributionAttributes,
  registerTraceAttribution,
  reportUserFacingError,
} from "../observability/sentry.js";
import {
  ChatHistorySync,
  hasMaterializedChatSession,
  waitForThreadSessionBootstrap,
} from "../sessions/chat-history-sync.js";
import { conversationIdOf, deriveSessionKey } from "../sessions/session-key.js";
import { formatNothingRunning, formatStopped, formatStopping } from "../platform-messages.js";
import * as Sentry from "@sentry/node";
import { join } from "path";
import { getUnresolvedSandboxPathContext } from "../sandbox/index.js";
import { disabledVaultManager } from "../vault/disabled.js";
import type { ConversationRuntimeState } from "./types.js";

type ConversationState = ConversationRuntimeState;

export type {
  RunSessionOptions,
  ConversationRuntime,
  ConversationRuntimeOptions,
} from "./types.js";
import type {
  RunSessionOptions,
  ConversationRuntime,
  ConversationRuntimeOptions,
  SessionStateOptions,
} from "./types.js";

const MAX_SESSIONS = 500;
const IDLE_TIMEOUT_MS = 3_600_000;

/**
 * Placeholder token store for embedders that run without the web portal.
 * Command handlers guard on `portalBaseUrl` before minting tokens, so this
 * only fires when a portal URL is configured without its backing store.
 */
function portalNotConfiguredTokenStore(portal: string): { create: () => never } {
  return {
    create: () => {
      throw new Error(`${portal} portal not configured`);
    },
  };
}

function runtimeCwdForSandbox(
  sandbox: ConversationRuntimeOptions["sandbox"],
  hostWorkspaceRoot: string,
  conversationId: string,
): string {
  const runtimeWorkspaceRoot = getUnresolvedSandboxPathContext(
    sandbox,
    hostWorkspaceRoot,
  ).runtimeWorkspaceRoot;
  return `${runtimeWorkspaceRoot.replace(/\/+$/, "")}/${conversationId}`;
}

export function createConversationRuntime(
  options: ConversationRuntimeOptions,
): ConversationRuntime {
  return new ConversationRuntimeImpl(options);
}

class ConversationRuntimeImpl implements ConversationRuntime {
  private readonly conversationStates = new Map<string, ConversationState>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly inFlightRuns = new Set<Promise<void>>();
  private readonly chatSessionManager = new ChatHistorySync();
  private readonly commandServices: CommandServices;
  private readonly commandHandlers: readonly CommandHandler[];
  private isShuttingDown = false;

  constructor(private readonly options: ConversationRuntimeOptions) {
    this.commandServices = {
      ...options,
      resourceController: options.resourceController ?? options.provisioner,
      vaultManager: options.vaultManager ?? disabledVaultManager,
      linkTokenStore: options.linkTokenStore ?? portalNotConfiguredTokenStore("Login"),
      sessionViewTokenStore:
        options.sessionViewTokenStore ?? portalNotConfiguredTokenStore("Session viewer"),
      adminTokenStore: options.adminTokenStore ?? portalNotConfiguredTokenStore("Admin"),
      runtime: this,
    };
    this.commandHandlers = options.commandHandlers ?? defaultCommandHandlers();
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

  async handleStop(sessionKey: string, conversationId: string, bot: MessagingBot): Promise<void> {
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

  async handleNewCommand(
    sessionKey: string,
    conversationId: string,
    bot: MessagingBot,
  ): Promise<void> {
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

    this.discardState(sessionKey);

    log.logInfo(`[${conversationId}] Session reset: ${sessionKey}`);
    await bot.postMessage(conversationId, "Conversation reset. Send a new message to start fresh.");
  }

  async handleEvent(
    event: ConversationEvent,
    bot: MessagingBot,
    context: ConversationContext,
  ): Promise<void> {
    const sessionKey = deriveSessionKey(event);
    const previous = this.sessionQueues.get(sessionKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.runSession({ event, bot, context }));
    this.sessionQueues.set(sessionKey, next);
    try {
      await next;
    } finally {
      if (this.sessionQueues.get(sessionKey) === next) {
        this.sessionQueues.delete(sessionKey);
      }
    }
  }

  async runSession({ event, bot, context }: RunSessionOptions): Promise<void> {
    const conversationId = event.conversationId;
    if (this.isShuttingDown) {
      log.logInfo(
        `[${conversationId}] Rejected event during shutdown: ${event.text.substring(0, 50)}`,
      );
      return;
    }

    const sessionKey = deriveSessionKey(event);
    const privateConversation = isPrivateConversation(event);
    const handledCommand = await dispatchCommand(this.commandHandlers, {
      bot,
      responder: context.responder,
      platform: context.platform.name as PlatformName,
      platformUserId: event.user,
      conversationId,
      vaultConversationId: event.vaultConversationId,
      sessionKey,
      commandText: event.text,
      privateConversation,
      services: this.commandServices,
    });
    if (handledCommand) return;

    const conversationDir = join(this.options.workingDir, conversationId);
    const waitedForParent = await waitForThreadSessionBootstrap({
      parentSessionKey: conversationId,
      sessionKey,
      hasThreadSession: () => hasMaterializedChatSession({ conversationDir, sessionKey }),
      isParentRunning: () => this.conversationStates.get(conversationId)?.running === true,
    });
    if (waitedForParent) {
      log.logInfo(
        `[${conversationId}] Delayed thread bootstrap until parent session sealed: ${sessionKey}`,
      );
    }

    let state: ConversationState;
    try {
      state = await this.getOrCreateState({
        conversationId,
        sessionKey,
        currentMessageId: event.ts,
        conversationKind: event.conversationKind,
      });
      state.runner.syncChatHistory(event.ts);

      // Extension-contributed commands: deterministic dispatch, no agent run.
      // Built-in commands already had their chance above, so extensions can
      // never shadow them; unmatched slash text falls through to the agent.
      if (event.text.trim().startsWith("/")) {
        const handled = await state.runner.tryExtensionCommand(context.message, context.responder);
        if (handled) {
          state.lastAccessedAt = Date.now();
          return;
        }
      }
    } catch (err) {
      reportUserFacingError(err, {
        domain: "mikan",
        surface: "session_setup",
        operation: "get_or_create_state",
        severity: "error",
        platform: context.platform.name,
        context: {
          conversationId,
          sessionKey,
          messageId: context.message.id,
          threadTs: context.message.threadTs,
          attachmentCount: context.message.attachments?.length ?? 0,
        },
      });
      throw err;
    }

    state.running = true;
    state.stopRequested = false;
    state.startedAt = Date.now();
    state.lastActivityAt = Date.now();

    log.logInfo(`[${conversationId}] Starting run: ${event.text.substring(0, 50)}`);

    const runPromise = (async () => {
      try {
        const result = await this.runWithInstrumentation(
          context,
          { conversationId, sessionKey, startedAt: state.startedAt },
          async () => {
            await context.responder.setTyping(true);
            await context.responder.setWorking(true);
            try {
              return await state.runner.run(context.message, context.responder, context.platform);
            } finally {
              await context.responder.setWorking(false);
            }
          },
        );

        if (result?.stopReason === "aborted" && state.stopRequested) {
          if (state.stopMessageTs) {
            await bot.updateMessage(conversationId, state.stopMessageTs, formatStopped(bot));
            state.stopMessageTs = undefined;
          } else {
            await bot.postMessage(conversationId, formatStopped(bot));
          }
        }
      } finally {
        state.running = false;
        state.lastAccessedAt = Date.now();
        Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size - 1);
        this.evictIdleSessions();
      }
    })();

    this.inFlightRuns.add(runPromise);
    Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size);
    try {
      await runPromise;
    } finally {
      this.inFlightRuns.delete(runPromise);
    }
  }

  private async runWithInstrumentation(
    context: ConversationContext,
    meta: {
      conversationId: string;
      sessionKey: string;
      startedAt: number;
    },
    body: () => Promise<{ stopReason: string; errorMessage?: string }>,
  ): Promise<{ stopReason: string; errorMessage?: string } | undefined> {
    const { conversationId, sessionKey, startedAt } = meta;
    const { message, platform } = context;

    const attribution = createRunAttributionAttributes({
      conversationId,
      sessionKey,
      messageId: message.id,
      platform: platform.name,
      userId: message.userId,
      userName: message.userName,
      threadTs: message.threadTs,
    });

    Sentry.metrics.count("agent.run.started", 1, {
      attributes: attribution,
    });

    return Sentry.startSpan(
      { name: "agent.run", op: "agent", attributes: attribution },
      async (span) =>
        Sentry.withScope(async (scope) => {
          registerTraceAttribution(span, attribution);
          applyRunScope(scope, {
            conversationId,
            sessionKey,
            messageId: message.id,
            platform: platform.name,
            userId: message.userId,
            userName: message.userName,
            threadTs: message.threadTs,
          });
          addLifecycleBreadcrumb("agent.run.started", {
            channel_id: conversationId,
            platform: platform.name,
            has_attachments: (message.attachments?.length ?? 0) > 0,
          });

          try {
            const result = await body();
            const durationMs = Date.now() - startedAt;
            const completionAttrs = {
              ...attribution,
              stop_reason: result.stopReason,
            };
            Sentry.metrics.distribution("agent.run.duration", durationMs, {
              unit: "millisecond",
              attributes: completionAttrs,
            });
            Sentry.metrics.count("agent.run.completed", 1, { attributes: completionAttrs });
            addLifecycleBreadcrumb("agent.run.completed", {
              channel_id: conversationId,
              platform: platform.name,
              stop_reason: result.stopReason,
              duration_ms: durationMs,
            });
            return result;
          } catch (err) {
            scope.setContext("agent_run_error", {
              conversationId,
              sessionKey,
              platform: platform.name,
              messageId: message.id,
              threadTs: message.threadTs,
            });
            reportUserFacingError(err, {
              domain: "mikan",
              surface: "agent_run",
              operation: "run",
              severity: "error",
              platform: platform.name,
              context: {
                conversationId,
                sessionKey,
                messageId: message.id,
                threadTs: message.threadTs,
                attachmentCount: message.attachments?.length ?? 0,
              },
            });
            Sentry.metrics.count("agent.run.errors", 1, {
              attributes: attribution,
            });
            log.logWarning(
              `[${conversationId}] Run error`,
              err instanceof Error ? err.message : String(err),
            );
            return undefined;
          }
        }),
    );
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

  refreshAllConversations(): { busy: string[] } {
    const conversationIds = new Set(
      Array.from(this.conversationStates.keys(), (sessionKey) => conversationIdOf(sessionKey)),
    );
    const busy: string[] = [];
    for (const conversationId of conversationIds) {
      const cleared = this.clearConversationStates(
        conversationId,
        `[${conversationId}] Global settings changed; cleared cached session runners`,
      );
      if (!cleared) busy.push(conversationId);
    }
    return { busy };
  }

  private isConversationSession(sessionKey: string, conversationId: string): boolean {
    return conversationIdOf(sessionKey) === conversationId;
  }

  private clearConversationStates(conversationId: string, message: string): boolean {
    for (const [sessionKey, state] of this.conversationStates) {
      if (this.isConversationSession(sessionKey, conversationId) && state.running) {
        return false;
      }
    }

    for (const sessionKey of Array.from(this.conversationStates.keys())) {
      if (this.isConversationSession(sessionKey, conversationId)) {
        this.discardState(sessionKey);
      }
    }
    log.logInfo(message);
    return true;
  }

  private async getOrCreateState(
    options: SessionStateOptions & { currentMessageId?: string },
  ): Promise<ConversationState> {
    const { conversationId, sessionKey, currentMessageId } = options;
    const existing = this.conversationStates.get(sessionKey);
    if (existing?.running) return existing;

    const conversationDir = join(this.options.workingDir, conversationId);
    const runtimeCwd = runtimeCwdForSandbox(
      this.options.sandbox,
      this.options.workingDir,
      conversationId,
    );
    const sessionScope = await this.chatSessionManager.resolveSessionScope({
      conversationDir,
      sessionKey,
      cwd: runtimeCwd,
      currentMessageId,
      rotateTopLevelSession: options.conversationKind === "shared" && sessionKey === conversationId,
    });

    if (existing && existing.sessionFile === sessionScope.contextFile) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // A stale state (rotated session file) is being replaced: release the old
    // runner's extension resources before the new one takes the slot.
    if (existing) this.discardState(sessionKey);

    const state: ConversationState = {
      running: false,
      runner: await createRunner({
        sandboxConfig: this.options.sandbox,
        sessionKey,
        conversationId,
        conversationDir,
        workspaceDir: this.options.workingDir,
        sessionScope,
        vaultManager: this.options.vaultManager,
        provisioner: this.options.provisioner,
        resourceController: this.options.resourceController,
        sessionView: this.options.sessionViewTokenStore
          ? {
              tokenStore: this.options.sessionViewTokenStore,
              portalBaseUrl: this.options.portalBaseUrl,
            }
          : undefined,
        platformNotifier: this.options.platformNotifier,
        platformReactor: this.options.platformReactor,
        platformUploader: this.options.platformUploader,
        platformToolPackFactories: this.options.platformToolPackFactories,
        models: this.options.models,
      }),
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: sessionScope.contextFile,
      startedAt: 0,
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

  /**
   * Remove a session state and release its resources: fire-and-forget the
   * runner's extension disposers so a slow disposer never stalls the caller.
   */
  private discardState(sessionKey: string): void {
    const state = this.conversationStates.get(sessionKey);
    if (!state) return;
    this.conversationStates.delete(sessionKey);
    state.runner.dispose().catch((err: unknown) => {
      log.logWarning(
        `Runner dispose failed: ${sessionKey}`,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  private evictIdleSessions(): void {
    const now = Date.now();

    for (const [key, state] of this.conversationStates) {
      if (!state.running && now - state.lastAccessedAt > IDLE_TIMEOUT_MS) {
        this.discardState(key);
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
        this.discardState(idleSessions[i].key);
      }
    }
  }
}
