import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  HandleNewCommandOptions,
  OfficeAddress,
  PlatformName,
  RunningSession,
} from "../adapter.js";
import type { Workspace } from "../office/index.js";
import { createRunner } from "../agent/runner.js";
import { commitOfficeDream, generateMemoryAnchor, prepareOfficeDream } from "../dream/index.js";
import type { PiAgentWrapper } from "../types.js";
import { MikanModels } from "../harness/index.js";
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
import { shouldRotateTopLevelSession } from "../sessions/store.js";
import {
  getThreadSessionFile,
  resolveChannelSessionFile,
  tryResolveThreadSession,
} from "../sessions/store.js";
import {
  assertSessionKeyBelongsToConversation,
  deriveSessionKey,
} from "../sessions/session-key.js";
import { formatNothingRunning, formatStopped, formatStopping } from "../platform-messages.js";
import * as Sentry from "@sentry/node";
import { getUnresolvedSandboxPathContext } from "../sandbox/index.js";
import { disabledVaultManager } from "../vault/index.js";
import type { ConversationRuntimeState } from "./types.js";
import { SessionLifecycle } from "./session-lifecycle.js";

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
  workspace: Workspace,
  address: OfficeAddress,
): string {
  const runtimeWorkspaceRoot = getUnresolvedSandboxPathContext(
    sandbox,
    workspace.root,
  ).runtimeWorkspaceRoot;
  // The office key names the same segment on the host and in the runtime.
  return `${runtimeWorkspaceRoot.replace(/\/+$/, "")}/${workspace.office(address).key}`;
}

export function createConversationRuntime(
  options: ConversationRuntimeOptions,
): ConversationRuntime {
  return new ConversationRuntimeImpl(options);
}

class ConversationRuntimeImpl implements ConversationRuntime {
  private readonly sessions = new SessionLifecycle();
  private readonly chatSessionManager = new ChatHistorySync();
  private readonly commandServices: CommandServices;
  private readonly commandHandlers: readonly CommandHandler[];
  private readonly resolvedModels: MikanModels;
  private isShuttingDown = false;

  constructor(private readonly options: ConversationRuntimeOptions) {
    this.resolvedModels = options.models ?? MikanModels.create();
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
    this.commandHandlers = options.commandHandlers ?? defaultCommandHandlers(this.resolvedModels);
  }

  isRunning(address: OfficeAddress, sessionKey: string): boolean {
    return this.sessions.get(address, sessionKey)?.running === true;
  }

  getRunningSessions(): RunningSession[] {
    const sessions: RunningSession[] = [];
    for (const state of this.sessions.runningStates()) {
      if (state.startedAt) {
        const currentStep = state.runner.getCurrentStep();
        sessions.push({
          address: state.address,
          sessionKey: state.sessionKey,
          startedAt: state.startedAt,
          lastActivityAt: state.lastActivityAt,
          currentTool: currentStep?.label || currentStep?.toolName,
        });
      }
    }
    return sessions;
  }

  async runDream(address: OfficeAddress, now = new Date()): Promise<boolean> {
    return this.sessions.runConversationMaintenance(address, async () => {
      const office = this.options.workspace.office(address);
      const plan = await prepareOfficeDream(office, now);
      if (!plan) return false;
      const memory = await generateMemoryAnchor(office, plan, this.resolvedModels);
      commitOfficeDream(office, plan, memory);
      log.logInfo(`[${address.conversationId}] Dream updated the Memory anchor`);
      return true;
    });
  }

  async handleStop(address: OfficeAddress, sessionKey: string, bot: MessagingBot): Promise<void> {
    assertSessionKeyBelongsToConversation(sessionKey, address.conversationId);
    const state = this.sessions.get(address, sessionKey);
    if (state?.running) {
      state.stopRequested = true;
      state.runner.abort();
      const ts = await bot.postMessage(address.conversationId, formatStopping(bot));
      state.stopMessageTs = ts;
    } else {
      await bot.postMessage(address.conversationId, formatNothingRunning(bot));
    }
  }

  forceStop(address: OfficeAddress, sessionKey: string): void {
    const state = this.sessions.get(address, sessionKey);
    if (state?.running) {
      log.logInfo(`[Force Stop] Force stopping session: ${sessionKey}`);
      state.stopRequested = true;
      state.runner.abort();
    }
  }

  async handleNewCommand({
    sessionKey,
    conversationId,
    bot,
    message,
  }: HandleNewCommandOptions): Promise<void> {
    const address = message.address;
    if (conversationId !== address.conversationId) {
      throw new Error(
        `Conversation id ${JSON.stringify(conversationId)} does not match office ` +
          JSON.stringify(address.conversationId),
      );
    }
    assertSessionKeyBelongsToConversation(sessionKey, address.conversationId);

    const activeState = this.sessions.get(address, sessionKey);
    if (activeState?.runSettlement) {
      if (activeState.running) {
        activeState.stopRequested = true;
        activeState.runner.abort();
      }
      await activeState.runSettlement;
    }

    await this.sessions.runConversationMaintenance(address, async () => {
      await this.resetSession(address, sessionKey, bot);
    });
  }

  private scheduleSharedSessionRotation(
    { event, bot, context }: RunSessionOptions,
    sessionKey: string,
  ): boolean {
    const { address, conversationId } = event;
    if (context.message.conversationKind !== "shared" || sessionKey !== conversationId)
      return false;

    const conversationDir = this.options.workspace.office(address).dir;
    const currentSession = resolveChannelSessionFile(conversationDir);
    if (!currentSession || !shouldRotateTopLevelSession(currentSession, new Date())) return false;

    void this.sessions
      .runConversationMaintenance(address, async () => {
        const session = resolveChannelSessionFile(conversationDir);
        if (!session || !shouldRotateTopLevelSession(session, new Date())) {
          await this.runSession({ event, bot, context }, true);
          return;
        }

        const runtimeCwd = runtimeCwdForSandbox(
          this.options.sandbox,
          this.options.workspace,
          address,
        );
        await this.chatSessionManager.resetSession({
          conversationDir,
          sessionKey,
          cwd: runtimeCwd,
        });
        await this.sessions.discardAndWait(address, sessionKey);
        log.logInfo(`[${conversationId}] Rotated session: ${sessionKey}`);
        await this.runSession({ event, bot, context }, true);
      })
      .catch((err) => {
        reportUserFacingError(err, {
          domain: "mikan",
          surface: "session_rotation",
          operation: "rotate_shared_session_in_background",
        });
      });
    return true;
  }

  private async resetSession(
    address: OfficeAddress,
    sessionKey: string,
    bot: MessagingBot,
  ): Promise<void> {
    const conversationId = address.conversationId;
    const conversationDir = this.options.workspace.office(address).dir;
    const runtimeCwd = runtimeCwdForSandbox(this.options.sandbox, this.options.workspace, address);
    await this.chatSessionManager.resetSession({ conversationDir, sessionKey, cwd: runtimeCwd });

    await this.sessions.discardAndWait(address, sessionKey);

    log.logInfo(`[${conversationId}] Session reset: ${sessionKey}`);
    await bot.postMessage(conversationId, "Conversation reset. Send a new message to start fresh.");
  }

  async handleEvent(
    event: ConversationEvent,
    bot: MessagingBot,
    context: ConversationContext,
  ): Promise<void> {
    const sessionKey = deriveSessionKey(event);
    await this.sessions.enqueue(event.address, sessionKey, () =>
      this.runSession({ event, bot, context }),
    );
  }

  async runSession(
    { event, bot, context }: RunSessionOptions,
    skipRotation = false,
  ): Promise<void> {
    const conversationId = event.conversationId;
    if (this.isShuttingDown) {
      log.logInfo(
        `[${conversationId}] Rejected event during shutdown: ${event.text.substring(0, 50)}`,
      );
      return;
    }

    const sessionKey = deriveSessionKey(event);
    if (!skipRotation && (await this.dispatchSessionCommand({ event, bot, context }, sessionKey))) {
      return;
    }

    const address = event.address;
    const activeSettlement = this.sessions.get(address, sessionKey)?.runSettlement;
    if (activeSettlement) await activeSettlement;

    if (
      !skipRotation &&
      sessionKey === conversationId &&
      this.scheduleSharedSessionRotation({ event, bot, context }, sessionKey)
    ) {
      return;
    }

    const releaseConversationWork = skipRotation
      ? () => {}
      : await this.sessions.acquireConversationWork(address);
    try {
      const conversationDir = this.options.workspace.office(address).dir;
      await this.waitForParentSession(address, sessionKey, conversationDir);

      let lease: { state: ConversationState; release: () => void } | undefined;
      try {
        lease = await this.acquireState({
          address,
          sessionKey,
          currentMessageId: event.ts,
          trustModel: context.platform.trustModel ?? "membership",
          platformWorkspaceId: context.platform.workspaceId,
        });
        const { state } = lease;
        await state.runner.syncChatHistory(event.ts);
      } catch (err) {
        lease?.release();
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

      const { state } = lease;
      log.logInfo(`[${conversationId}] Starting run: ${event.text.substring(0, 50)}`);
      const runPromise = this.sessions.settle(state, async () => {
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
          Sentry.metrics.gauge("agent.sessions.active", this.sessions.settlementCount() - 1);
        }
      });
      lease.release();
      Sentry.metrics.gauge("agent.sessions.active", this.sessions.settlementCount());
      await runPromise;
    } finally {
      releaseConversationWork();
    }
  }

  private async waitForParentSession(
    address: OfficeAddress,
    sessionKey: string,
    conversationDir: string,
  ): Promise<void> {
    const conversationId = address.conversationId;
    const waited = await waitForThreadSessionBootstrap({
      parentSessionKey: conversationId,
      sessionKey,
      hasThreadSession: () => hasMaterializedChatSession({ conversationDir, sessionKey }),
      isParentRunning: () => this.sessions.get(address, conversationId)?.running === true,
    });
    if (waited) {
      log.logInfo(
        `[${conversationId}] Delayed thread bootstrap until parent session sealed: ${sessionKey}`,
      );
    }
  }

  private async dispatchSessionCommand(
    { event, bot, context }: RunSessionOptions,
    sessionKey: string,
  ): Promise<boolean> {
    return dispatchCommand(this.commandHandlers, {
      bot,
      responder: context.responder,
      platform: context.platform.name as PlatformName,
      address: event.address,
      platformUserId: event.user,
      platformUserName: context.message.userName,
      conversationId: event.conversationId,
      vaultConversationId: event.vaultConversationId,
      sessionKey,
      commandText: event.text,
      privateConversation: isPrivateConversation(event),
      services: this.commandServices,
    });
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

  switchConversationModel(address: OfficeAddress, _provider: string, _model: string): boolean {
    return this.invalidateOffice(address, "Model switched");
  }

  refreshConversationEnvironment(address: OfficeAddress): boolean {
    return this.invalidateOffice(address, "Environment refreshed");
  }

  refreshAllConversations(): { busy: OfficeAddress[] } {
    const offices = this.sessions.offices();
    const result = this.sessions.invalidateAll();
    const busyKeys = new Set(
      result.busy.map((address) => `${address.platform}:${address.conversationId}`),
    );
    for (const address of offices) {
      if (busyKeys.has(`${address.platform}:${address.conversationId}`)) continue;
      log.logInfo(
        `[${address.conversationId}] Global settings changed; cleared cached session runners`,
      );
    }
    return result;
  }

  private invalidateOffice(address: OfficeAddress, reason: string): boolean {
    const cleared = this.sessions.invalidateConversation(address);
    if (cleared) {
      log.logInfo(`[${address.conversationId}] ${reason}; cleared cached session runners`);
    }
    return cleared;
  }

  private async createCurrentRunner(
    options: SessionStateOptions,
    sessionScope: Awaited<ReturnType<ChatHistorySync["resolveSessionScope"]>>,
  ): Promise<PiAgentWrapper> {
    return createRunner({
      sandboxConfig: this.options.sandbox,
      sessionKey: options.sessionKey,
      office: this.options.workspace.office(options.address),
      trustModel: options.trustModel,
      platformWorkspaceId: options.platformWorkspaceId,
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
      platformToolPackFactories: this.options.platformToolPackFactories,
      models: this.resolvedModels,
    });
  }

  private acquireState(options: SessionStateOptions & { currentMessageId?: string }) {
    const { address, sessionKey } = options;
    const conversationDir = this.options.workspace.office(address).dir;
    return this.sessions.acquire(
      address,
      sessionKey,
      () =>
        sessionKey === address.conversationId
          ? resolveChannelSessionFile(conversationDir)
          : tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey)),
      () => this.materializeState(options, conversationDir),
    );
  }

  private async materializeState(
    options: SessionStateOptions & { currentMessageId?: string },
    conversationDir: string,
  ): Promise<ConversationState> {
    const { address, sessionKey, currentMessageId } = options;
    const runtimeCwd = runtimeCwdForSandbox(this.options.sandbox, this.options.workspace, address);
    const sessionScope = await this.chatSessionManager.resolveSessionScope({
      conversationDir,
      sessionKey,
      cwd: runtimeCwd,
      currentMessageId,
    });
    return {
      address,
      sessionKey,
      running: false,
      runner: await this.createCurrentRunner(options, sessionScope),
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: sessionScope.contextFile,
      startedAt: 0,
    };
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    log.logInfo("Shutting down gracefully...");
    await this.sessions.shutdown(timeoutMs);
  }
}
