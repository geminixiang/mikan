import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  ConversationKind,
  OfficeAddress,
  PlatformName,
  RunningSession,
} from "../adapter.js";
import { createOfficeAddress, officeKey, type Workspace } from "../office/index.js";
import { createRunner } from "../agent/runner.js";
import type { PiAgentWrapper } from "../types.js";
import { MikanModels } from "../harness/index.js";
import type { ExtensionBlockAction, ExtensionScheduleCallbackFire } from "../harness/index.js";
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
  private readonly inFlightRuns = new Set<Promise<void>>();
  private readonly sessionDreamSettlements = new Set<Promise<void>>();
  private readonly chatSessionManager = new ChatHistorySync();
  private readonly commandServices: CommandServices;
  private readonly commandHandlers: readonly CommandHandler[];
  private readonly resolvedModels: MikanModels;
  private globalRunnerGeneration = 0;
  private readonly conversationRunnerGenerations = new Map<string, number>();
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
    return this.sessions.isRunning(address, sessionKey);
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

  async handleNewCommand(
    sessionKey: string,
    conversationId: string,
    bot: MessagingBot,
    message: ConversationContext["message"],
    responder: ConversationContext["responder"],
    platform: ConversationContext["platform"],
  ): Promise<void> {
    // The message's address is the authority; the raw id is still passed for
    // filesystem layout, so a disagreement must fail loudly, not pick one.
    const address = message.address;
    if (conversationId !== address.conversationId) {
      throw new Error(
        `Conversation id ${JSON.stringify(conversationId)} does not match office ` +
          JSON.stringify(address.conversationId),
      );
    }
    assertSessionKeyBelongsToConversation(sessionKey, address.conversationId);
    const activeState = this.sessions.get(address, sessionKey);
    if (
      activeState?.running ||
      (activeState?.runSettlement && this.sessionDreamSettlements.has(activeState.runSettlement))
    ) {
      const activeSettlement = activeState.runSettlement;
      if (activeSettlement && this.sessionDreamSettlements.has(activeSettlement)) {
        await activeSettlement;
        return;
      }
      activeState.stopRequested = true;
      activeState.runner.abort();
      await activeSettlement;
    }

    const state = await this.getOrCreateState({ address, sessionKey });
    // Scope resolution only materializes; the Session Dream below reads the
    // session, so bring it up to date with the log first.
    await state.runner.syncChatHistory(message.id);
    if (
      state.running ||
      (state.runSettlement && this.sessionDreamSettlements.has(state.runSettlement))
    ) {
      const activeSettlement = state.runSettlement;
      if (activeSettlement && this.sessionDreamSettlements.has(activeSettlement)) {
        await activeSettlement;
        return;
      }
      state.stopRequested = true;
      state.runner.abort();
      await activeSettlement;
      return this.handleNewCommand(sessionKey, conversationId, bot, message, responder, platform);
    }
    const dreamSettlement = this.startSessionDream(state, async () => {
      let working = false;
      try {
        await responder.setWorking(true);
        working = true;
        const result = await this.dreamSessionMemory(state, message, platform);
        if (!result.success) {
          const detail = result.errorMessage ? ` ${result.errorMessage}` : "";
          await responder.respondDiagnostic(
            `Could not preserve memory, so the current conversation was not reset.${detail}`,
            { style: "error" },
          );
          return;
        }

        await responder.setWorking(false);
        working = false;
        await this.resetSession(state, bot);
      } finally {
        if (working) await responder.setWorking(false);
      }
    });
    void dreamSettlement
      .catch((err) => {
        reportUserFacingError(err, {
          domain: "mikan",
          surface: "session_dream",
          operation: "run_new_command_in_background",
        });
      })
      .finally(() => this.finishSessionDream(state, dreamSettlement));
  }

  private startSessionDream(
    state: ConversationState,
    dream: () => Promise<void>,
    markRunning = true,
  ): Promise<void> {
    if (markRunning) {
      state.running = true;
      state.stopRequested = false;
      state.startedAt = Date.now();
      state.lastActivityAt = Date.now();
    }

    const settlement = Promise.resolve().then(dream);
    state.runSettlement = settlement;
    this.sessionDreamSettlements.add(settlement);
    this.inFlightRuns.add(settlement);
    return settlement;
  }

  private finishSessionDream(state: ConversationState, settlement: Promise<void>): void {
    this.sessionDreamSettlements.delete(settlement);
    this.inFlightRuns.delete(settlement);
    if (state.runSettlement !== settlement) return;

    state.runSettlement = undefined;
    state.running = false;
    state.startedAt = 0;
    state.lastAccessedAt = Date.now();
    this.sessions.onSettlement(state.address);
    this.sessions.evictIdle();
  }

  private async dreamSessionMemory(
    state: ConversationState,
    message: ConversationContext["message"],
    platform: ConversationContext["platform"],
  ): Promise<{ success: boolean; errorMessage?: string }> {
    try {
      const result = await state.runner.dreamSessionMemory(message, platform);
      // Only a clean stop means the dream finished its work. Everything else —
      // budget abort, length cutoff, error, blocked — leaves memory unwritten,
      // and treating it as success resets the session and loses it silently.
      // Listed as a whitelist so a new stop reason fails safe.
      if (result.stopReason !== "stop") {
        return {
          success: false,
          errorMessage: result.errorMessage ?? `Session Dream stopped early (${result.stopReason})`,
        };
      }
      return { success: true };
    } catch (err) {
      return { success: false, errorMessage: err instanceof Error ? err.message : String(err) };
    }
  }

  private scheduleSharedSessionRotation(
    { event, bot, context }: RunSessionOptions,
    sessionKey: string,
  ): boolean {
    const { address, conversationId } = event;
    const { message, platform } = context;
    if (message.conversationKind !== "shared" || sessionKey !== conversationId) return false;

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

        const state = await this.getOrCreateState({
          address,
          sessionKey,
          currentMessageId: message.id,
        });
        // The rotation Dream summarizes the session; sync the log into it
        // first (scope resolution only materializes).
        await state.runner.syncChatHistory(message.id);
        const dreamSettlement = this.startSessionDream(
          state,
          async () => {
            const result = await this.dreamSessionMemory(state, message, platform);
            if (!result.success) {
              const detail = result.errorMessage ? `: ${result.errorMessage}` : "";
              log.logWarning(`[${conversationId}] Automatic Session Dream failed${detail}`);
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
            log.logInfo(
              `[${conversationId}] Session Dream completed; rotated session: ${sessionKey}`,
            );
          },
          false,
        );
        try {
          await dreamSettlement;
        } finally {
          this.finishSessionDream(state, dreamSettlement);
        }
        await this.runSession({ event, bot, context }, true);
      })
      .catch((err) => {
        reportUserFacingError(err, {
          domain: "mikan",
          surface: "session_dream",
          operation: "rotate_shared_session_in_background",
        });
      });
    return true;
  }

  private async resetSession(state: ConversationState, bot: MessagingBot): Promise<void> {
    const { address, sessionKey } = state;
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

  /**
   * Dispatch an extension-owned interactive block action: materialize the
   * conversation's harness instance (activating its extensions) and run the
   * matching onAction handler — deterministic, no agent run. Serialized on
   * the session queue so rapid interactions (votes) never interleave.
   */
  async handleExtensionAction(params: {
    address: OfficeAddress;
    sessionKey: string;
    conversationKind: ConversationKind;
    slug: string;
    action: ExtensionBlockAction;
  }): Promise<boolean> {
    if (this.isShuttingDown) return false;
    const { address, sessionKey, slug, action } = params;
    const conversationId = address.conversationId;
    let consumed = false;
    await this.sessions.enqueue(address, sessionKey, async () => {
      try {
        const state = await this.getOrCreateState({
          address,
          sessionKey,
          currentMessageId: action.messageTs ?? sessionKey,
        });
        consumed = await state.runner.tryExtensionAction(slug, action);
        if (consumed) state.lastAccessedAt = Date.now();
      } catch (err) {
        log.logWarning(
          `[${conversationId}] Extension action dispatch failed (${slug}:${action.actionId})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    return consumed;
  }

  /**
   * Dispatch a fired extension callback schedule: materialize the
   * conversation's harness instance (activating its extensions) and run the
   * matching `onCallback` handler — deterministic, no agent run, no model
   * call. Serialized on the session queue so fires never interleave with
   * block actions or runs in the same conversation.
   */
  async handleExtensionScheduleCallback(fire: ExtensionScheduleCallbackFire): Promise<boolean> {
    if (this.isShuttingDown) return false;
    const address = createOfficeAddress(fire.platform as PlatformName, fire.conversationId);
    const conversationId = fire.conversationId;
    // Schedules belong to the conversation, not a thread: use the top-level
    // session scope, like the schedules that fire agent runs.
    const sessionKey = conversationId;
    let consumed = false;
    await this.sessions.enqueue(address, sessionKey, async () => {
      try {
        const state = await this.getOrCreateState({
          address,
          sessionKey,
          currentMessageId: `extsched:${fire.slug}.${fire.scheduleName}`,
        });
        consumed = await state.runner.tryExtensionScheduleCallback(fire.slug, fire.callback, {
          scheduleName: fire.scheduleName,
          ...(fire.args !== undefined ? { args: fire.args } : {}),
        });
        if (consumed) state.lastAccessedAt = Date.now();
      } catch (err) {
        log.logWarning(
          `[${conversationId}] Extension schedule dispatch failed (${fire.slug}.${fire.scheduleName} → ${fire.callback})`,
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    return consumed;
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
    if (!skipRotation) {
      const privateConversation = isPrivateConversation(event);
      const handledCommand = await dispatchCommand(this.commandHandlers, {
        bot,
        responder: context.responder,
        platform: context.platform.name as PlatformName,
        address: event.address,
        platformUserId: event.user,
        platformUserName: context.message.userName,
        conversationId,
        vaultConversationId: event.vaultConversationId,
        sessionKey,
        commandText: event.text,
        privateConversation,
        services: this.commandServices,
      });
      if (handledCommand) return;
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
      const waitedForParent = await waitForThreadSessionBootstrap({
        parentSessionKey: conversationId,
        sessionKey,
        hasThreadSession: () => hasMaterializedChatSession({ conversationDir, sessionKey }),
        isParentRunning: () => this.sessions.get(address, conversationId)?.running === true,
      });
      if (waitedForParent) {
        log.logInfo(
          `[${conversationId}] Delayed thread bootstrap until parent session sealed: ${sessionKey}`,
        );
      }

      let state: ConversationState;
      try {
        state = await this.getOrCreateState({
          address,
          sessionKey,
          currentMessageId: event.ts,
        });
        await state.runner.syncChatHistory(event.ts);

        // Extension-contributed commands: deterministic dispatch, no agent run.
        // Built-in commands already had their chance above, so extensions can
        // never shadow them; unmatched text falls through to the agent.
        //
        // Where the platform eats the slash before we ever see it, the leading
        // name alone is enough — otherwise those commands would be unreachable
        // rather than merely awkward.
        const bareName = context.platform.bareExtensionCommands === true;
        if (bareName || event.text.trim().startsWith("/")) {
          const handled = await state.runner.tryExtensionCommand(
            context.message,
            context.responder,
            { bareName },
          );
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
        }
      })();

      this.inFlightRuns.add(runPromise);
      state.runSettlement = runPromise;
      Sentry.metrics.gauge("agent.sessions.active", this.inFlightRuns.size);
      try {
        await runPromise;
      } finally {
        this.inFlightRuns.delete(runPromise);
        if (state.runSettlement === runPromise) state.runSettlement = undefined;
        this.sessions.onSettlement(address);
        this.sessions.evictIdle();
      }
    } finally {
      releaseConversationWork();
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

  switchConversationModel(address: OfficeAddress, _provider: string, _model: string): boolean {
    this.bumpConversationRunnerGeneration(address);
    return this.clearOffice(address, "Model switched");
  }

  refreshConversationEnvironment(address: OfficeAddress): boolean {
    this.bumpConversationRunnerGeneration(address);
    return this.clearOffice(address, "Environment refreshed");
  }

  refreshAllConversations(): { busy: OfficeAddress[] } {
    this.globalRunnerGeneration++;
    const busy: OfficeAddress[] = [];
    for (const address of this.sessions.offices()) {
      if (!this.clearOffice(address, "Global settings changed")) {
        this.sessions.deferConversationClear(address);
        busy.push(address);
      }
    }
    return { busy };
  }

  private clearOffice(address: OfficeAddress, reason: string): boolean {
    const cleared = this.sessions.clearConversation(address);
    if (cleared) {
      log.logInfo(`[${address.conversationId}] ${reason}; cleared cached session runners`);
    }
    return cleared;
  }

  private bumpConversationRunnerGeneration(address: OfficeAddress): void {
    const key = officeKey(address);
    this.conversationRunnerGenerations.set(
      key,
      (this.conversationRunnerGenerations.get(key) ?? 0) + 1,
    );
  }

  private runnerGeneration(address: OfficeAddress): string {
    return `${this.globalRunnerGeneration}:${this.conversationRunnerGenerations.get(officeKey(address)) ?? 0}`;
  }

  private async createCurrentRunner(
    options: SessionStateOptions,
    sessionScope: Awaited<ReturnType<ChatHistorySync["resolveSessionScope"]>>,
  ): Promise<PiAgentWrapper> {
    while (true) {
      const generation = this.runnerGeneration(options.address);
      const runner = await createRunner({
        sandboxConfig: this.options.sandbox,
        sessionKey: options.sessionKey,
        office: this.options.workspace.office(options.address),
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
        platformBlockKit: this.options.platformBlockKit,
        platformDmOpener: this.options.platformDmOpener,
        platformHistoryFetcher: this.options.platformHistoryFetcher,
        platformUserLister: this.options.platformUserLister,
        extensionScheduleEngine: this.options.extensionScheduleEngine,
        platformToolPackFactories: this.options.platformToolPackFactories,
        models: this.resolvedModels,
      });
      if (generation === this.runnerGeneration(options.address)) return runner;
      await runner.dispose();
    }
  }

  private async getOrCreateState(
    options: SessionStateOptions & { currentMessageId?: string },
  ): Promise<ConversationState> {
    return this.sessions.transition(options.address, options.sessionKey, () =>
      this.getOrCreateStateExclusive(options),
    );
  }

  private async getOrCreateStateExclusive(
    options: SessionStateOptions & { currentMessageId?: string },
  ): Promise<ConversationState> {
    const { address, sessionKey, currentMessageId } = options;
    await this.sessions.waitForClose(address, sessionKey);
    const existing = this.sessions.get(address, sessionKey);
    // A cached runner is the sole writable pi v4 session handle for its file:
    // reuse it before scope resolution can open the same path a second time.
    const conversationDir = this.options.workspace.office(address).dir;
    const expectedFile =
      sessionKey === address.conversationId
        ? resolveChannelSessionFile(conversationDir)
        : tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey));
    if (existing && expectedFile === existing.sessionFile) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }
    if (existing?.running) return existing;
    if (existing) await this.sessions.discardAndWait(address, sessionKey);

    const runtimeCwd = runtimeCwdForSandbox(this.options.sandbox, this.options.workspace, address);
    const sessionScope = await this.chatSessionManager.resolveSessionScope({
      conversationDir,
      sessionKey,
      cwd: runtimeCwd,
      currentMessageId,
    });

    const state: ConversationState = {
      address,
      sessionKey,
      running: false,
      runner: await this.createCurrentRunner(options, sessionScope),
      stopRequested: false,
      lastAccessedAt: Date.now(),
      sessionFile: sessionScope.contextFile,
      startedAt: 0,
    };
    this.sessions.set(state);
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
      log.logWarning(
        `Aborting ${this.inFlightRuns.size} runs after shutdown timeout`,
        `${timeoutMs}ms`,
      );
      for (const state of this.sessions.runningStates()) state.runner.abort();
      const closeDeadline = Date.now() + 5_000;
      while (this.inFlightRuns.size > 0 && Date.now() < closeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.inFlightRuns.size > 0) {
        throw new Error(
          `Shutdown could not settle ${this.inFlightRuns.size} aborted runs within 5000ms`,
        );
      }
    }
    await this.sessions.closeAll();
  }
}
