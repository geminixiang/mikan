import type { BotAdapters, PlatformName } from "../adapter.js";
import { waitForThreadSessionBootstrap } from "../sessions/chat-session-manager.js";
import { dispatchCommand } from "../commands/registry.js";
import type { CommandHandler, CommandServices } from "../commands/types.js";
import { isPrivateConversation } from "../commands/utils.js";
import * as log from "../log.js";
import {
  addLifecycleBreadcrumb,
  applyRunScope,
  reportUserFacingError,
} from "../observability/sentry.js";
import { formatStopped } from "../platform-messages.js";
import * as Sentry from "@sentry/node";
import { join } from "path";

export type { ConversationRuntimeState, RunConversationOptions } from "./types.js";
import type { ConversationRuntimeState, RunConversationOptions } from "./types.js";

interface ConversationOrchestratorOptions {
  workingDir: string;
  commandHandlers: readonly CommandHandler[];
  commandServices: CommandServices;
  isShuttingDown: () => boolean;
  getState: (sessionKey: string) => ConversationRuntimeState | undefined;
  getOrCreateState: (options: {
    conversationId: string;
    sessionKey: string;
    currentMessageId?: string;
  }) => Promise<ConversationRuntimeState>;
  hasMaterializedSession: (options: { conversationDir: string; sessionKey: string }) => boolean;
  beforeRunTracked: (runPromise: Promise<void>) => void;
  afterRunTracked: (runPromise: Promise<void>) => void;
  onRunFinished: () => void;
}

export class ConversationOrchestrator {
  constructor(private readonly options: ConversationOrchestratorOptions) {}

  async runSession({ event, bot, adapters }: RunConversationOptions): Promise<void> {
    const conversationId = event.conversationId;
    if (this.options.isShuttingDown()) {
      log.logInfo(
        `[${conversationId}] Rejected event during shutdown: ${event.text.substring(0, 50)}`,
      );
      return;
    }

    const sessionKey = event.sessionKey ?? `${conversationId}:${event.thread_ts ?? event.ts}`;
    const privateConversation = isPrivateConversation(event);
    const handledCommand = await dispatchCommand(this.options.commandHandlers, {
      bot,
      responseCtx: adapters.responseCtx,
      platform: adapters.platform.name as PlatformName,
      platformUserId: event.user,
      conversationId,
      vaultConversationId: event.vaultConversationId,
      sessionKey,
      commandText: event.text,
      privateConversation,
      services: this.options.commandServices,
    });
    if (handledCommand) return;

    const conversationDir = join(this.options.workingDir, conversationId);
    const waitedForParent = await waitForThreadSessionBootstrap({
      parentSessionKey: conversationId,
      sessionKey,
      hasThreadSession: () => this.options.hasMaterializedSession({ conversationDir, sessionKey }),
      isParentRunning: () => this.options.getState(conversationId)?.running === true,
    });
    if (waitedForParent) {
      log.logInfo(
        `[${conversationId}] Delayed thread bootstrap until parent session sealed: ${sessionKey}`,
      );
    }

    let state: ConversationRuntimeState;
    try {
      state = await this.options.getOrCreateState({
        conversationId,
        sessionKey,
        currentMessageId: event.ts,
      });
      state.runner.syncChatHistory(event.ts);
    } catch (err) {
      reportUserFacingError(err, {
        domain: "mikan",
        surface: "session_setup",
        operation: "get_or_create_state",
        severity: "error",
        platform: adapters.platform.name,
        context: {
          conversationId,
          sessionKey,
          messageId: adapters.message.id,
          threadTs: adapters.message.threadTs,
          attachmentCount: adapters.message.attachments?.length ?? 0,
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
          adapters,
          { conversationId, sessionKey, startedAt: state.startedAt! },
          async () => {
            await adapters.responseCtx.setTyping(true);
            await adapters.responseCtx.setWorking(true);
            const runnerResult = await state.runner.run(
              adapters.message,
              adapters.responseCtx,
              adapters.platform,
            );
            await adapters.responseCtx.setWorking(false);
            return runnerResult;
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
        this.options.onRunFinished();
      }
    })();

    this.options.beforeRunTracked(runPromise);
    try {
      await runPromise;
    } finally {
      this.options.afterRunTracked(runPromise);
    }
  }

  private async runWithInstrumentation(
    adapters: BotAdapters,
    meta: {
      conversationId: string;
      sessionKey: string;
      startedAt: number;
    },
    body: () => Promise<{ stopReason: string; errorMessage?: string }>,
  ): Promise<{ stopReason: string; errorMessage?: string } | undefined> {
    const { conversationId, sessionKey, startedAt } = meta;
    const { message, platform } = adapters;

    Sentry.metrics.count("agent.run.started", 1, {
      attributes: { channel: conversationId },
    });

    return Sentry.startSpan(
      { name: "agent.run", op: "agent", attributes: { conversationId, sessionKey } },
      async () =>
        Sentry.withScope(async (scope) => {
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
              channel: conversationId,
              platform: platform.name,
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
              attributes: { channel: conversationId, platform: platform.name },
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
}
