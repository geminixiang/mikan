import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_EVENT_BUDGET,
  defaultExtensionDirs,
  type ExtensionHostServices,
  type ExtensionSchedulePayload,
  loadExtensions,
  MikanAgentSession,
  MikanModels,
  type MikanSkill,
  type SessionStore,
} from "../harness/index.js";
import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";
import type {
  ConversationMessage,
  ConversationResponder,
  ConversationKind,
  MessagingInfo,
  PlatformName,
} from "../adapter.js";
import type {
  AgentEventPayload,
  MikanEvent,
  PlatformNotifier,
  PlatformReactor,
  PlatformTrustModel,
} from "../types.js";
import type { SessionViewTokenStoreLike } from "../commands/types.js";
import { resolveConversationSettings } from "../config.js";
import { readEnv } from "../utils/env.js";
import { ActorExecutionResolver } from "../execution-resolver.js";
import * as log from "../log.js";
import type { DockerContainerManager } from "../provisioner.js";
import {
  createExecutor,
  type Executor,
  type RuntimePathContext,
  type SandboxConfig,
} from "../sandbox/index.js";
import {
  addLifecycleBreadcrumb,
  metricAttributes,
  updateActiveSpanAttribution,
} from "../observability/sentry.js";
import type { VaultManager } from "../vault/index.js";
import { AgentMemoryFileManager } from "../sessions/agent-memory-file-manager.js";
import {
  extractSessionUuid,
  openManagedSession,
  type ResolvedSessionScope,
  type ThreadRootMessage,
} from "../sessions/store.js";
import { HostEventStore } from "../tools/event.js";
import { createMikanTools } from "../tools/index.js";
import type { PlatformToolPackFactory } from "../tools/types.js";
import * as Sentry from "@sentry/node";
import { resolveConfiguredModel } from "../model-registry.js";
import { emitAgentEvent } from "../agent-events.js";
import type { PiAgentWrapper } from "../types.js";
import {
  appendTriggerAttribution,
  buildSystemPrompt,
  buildTurnInstructions,
  getMemory,
  loadMikanSkills,
  mergeExtensionSkills,
  resolveTriggerAttribution,
} from "./prompt.js";
import { buildPromptPayload, writePromptDebugContext } from "./payload.js";
import { getUnresolvedSandboxPathContext, translateAttachPathToHost } from "./paths.js";
import {
  type RunnerSessionState,
  createRunState,
  resetRunState,
  createRunQueue,
  finalizeRunResponse,
  reportUsageSummary,
  replaceResponseWithToolProgress,
  extractToolLabel,
  extractToolResultText,
  formatResponseWithToolProgress,
  isEventTriggerAttribution,
} from "./run-lifecycle.js";

function buildThreadSessionName(message: ThreadRootMessage | null): string | undefined {
  const text = message?.text?.trim();
  if (!text) return undefined;
  const userLabel = message?.userName || message?.user || "unknown";
  return `[${userLabel}]: ${text}`;
}

interface RunnerExecutionContext {
  executionResolver?: ActorExecutionResolver;
  executor: Executor;
  getPathContext: () => RuntimePathContext;
  resolveExecutorForRun(context: {
    platform: string;
    userId: string;
    conversationId: string;
    trustModel?: PlatformTrustModel;
  }): Promise<void>;
}

interface PreparedRunContext {
  sessionConversation: string;
  runQueue: ReturnType<typeof createRunQueue>;
  userMessage: string;
  imageAttachments: ImageContent[];
  triggerAttribution?: string;
}

interface ConfiguredAgentSession {
  session: MikanAgentSession;
  /** Skills contributed by extensions, merged into each run's system prompt. */
  extensionSkills: MikanSkill[];
}

function createRunnerExecutionContext(
  sandboxConfig: SandboxConfig,
  vaultManager: VaultManager | undefined,
  provisioner: DockerContainerManager | undefined,
  workspaceDir: string,
  hostWorkspacePath: string,
): RunnerExecutionContext {
  const executionResolver =
    vaultManager && sandboxConfig.type !== "host"
      ? new ActorExecutionResolver(sandboxConfig, vaultManager, provisioner, workspaceDir)
      : undefined;

  // activeExecutor is replaced at the start of each run() call when executionResolver
  // is present, so the stable `executor` wrapper always delegates to the latest resolved value.
  let activeExecutor: Executor =
    executionResolver !== undefined
      ? createExecutor({ type: "host" })
      : createExecutor(sandboxConfig);
  const executor: Executor = {
    exec(command, options) {
      return activeExecutor.exec(command, options);
    },
    getWorkspacePath(hostPath) {
      return activeExecutor.getWorkspacePath(hostPath);
    },
    getSandboxConfig() {
      return activeExecutor.getSandboxConfig();
    },
    getPathContext(hostWorkspaceRoot) {
      return activeExecutor.getPathContext(hostWorkspaceRoot);
    },
  };

  return {
    executionResolver,
    executor,
    getPathContext: () => executor.getPathContext(hostWorkspacePath),
    async resolveExecutorForRun(context): Promise<void> {
      if (!executionResolver) return;
      activeExecutor = await executionResolver.resolve(context);
    },
  };
}

/**
 * Extension host services over mikan's runtime infrastructure: schedules
 * become event files under `<workspaceDir>/events` (picked up live by
 * EventsWatcher), secrets come from `vaults/extensions/<slug>/env`, and
 * notify posts through the platform bots when main.ts provides a notifier.
 */
function buildExtensionHostServices(params: {
  workspaceDir: string;
  vaultManager?: VaultManager;
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
}): ExtensionHostServices {
  const { workspaceDir, vaultManager, platformNotifier, platformReactor } = params;
  const eventStore = HostEventStore.fromWorkspaceDir(workspaceDir);
  return {
    stateDir: readEnv("STATE_DIR"),
    scheduleStore: {
      write: async (filename, payload) => {
        // Event files tolerate a missing platform (single-platform default),
        // so the harness payload is a valid event payload as written.
        await eventStore.write(filename, payload as unknown as MikanEvent);
      },
      delete: async (filename) => (await eventStore.delete(filename)).deleted,
      list: async () =>
        (await eventStore.list()).map((entry) => ({
          filename: entry.filename,
          payload: entry.payload as unknown as ExtensionSchedulePayload,
        })),
    },
    ...(platformNotifier ? { postMessage: platformNotifier } : {}),
    ...(platformReactor ? { addReaction: platformReactor } : {}),
    ...(vaultManager
      ? {
          resolveSecrets: (slug: string) => vaultManager.resolve(`extensions/${slug}`)?.env ?? {},
        }
      : {}),
  };
}

async function createConfiguredAgentSession(params: {
  conversationId: string;
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMikanTools>>["tools"];
  sessionStore: SessionStore;
  models: MikanModels;
  vaultManager?: VaultManager;
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
}): Promise<ConfiguredAgentSession> {
  const {
    conversationId,
    workspaceDir,
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    sessionStore,
    models,
    vaultManager,
    platformNotifier,
    platformReactor,
  } = params;

  // Host-only dirs under the state dir: extension code runs in the mikan
  // process, so it must never load from workspace paths — those are mounted
  // into sandbox containers and agent-writable (sandbox escape otherwise).
  const extensionsResult = await loadExtensions({
    dirs: defaultExtensionDirs(conversationId, readEnv("STATE_DIR")),
    context: { conversationId, workspaceDir, model, thinkingLevel },
    services: buildExtensionHostServices({
      workspaceDir,
      vaultManager,
      platformNotifier,
      platformReactor,
    }),
  });
  for (const err of extensionsResult.errors) {
    log.logWarning(`[${conversationId}] Extension load error: ${err.path}`, err.error);
  }
  if (extensionsResult.extensions.length > 0) {
    log.logInfo(
      `[${conversationId}] Loaded ${extensionsResult.extensions.length} extension(s): ${extensionsResult.extensions.map((extension) => extension.name).join(", ")}`,
    );
  }

  const session = new MikanAgentSession({
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    models,
    sessionStore,
    extensions: extensionsResult.registry,
  });

  const reloaded = session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from session context`);
  }
  return { session, extensionSkills: extensionsResult.skills };
}

function reloadSessionMessages(session: MikanAgentSession, conversationId: string): void {
  const reloaded = session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from context`);
  }
}

async function prepareRunContext(params: {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
  conversationId: string;
  conversationDir: string;
  sessionUuid: string;
  runState: RunnerSessionState;
  executor: Executor;
  executionResolver?: ActorExecutionResolver;
  resolveExecutorForRun: RunnerExecutionContext["resolveExecutorForRun"];
  getPathContext: () => RuntimePathContext;
  session: MikanAgentSession;
  extensionSkills?: MikanSkill[];
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: ConversationKind;
    userId: string;
  }) => void;
  setSandboxContext: (context: { conversationId: string; userId: string }) => void;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  bindPlatformToolPacks: (ctx: { conversationId: string; platformName: string }) => void;
  pathContext: RuntimePathContext;
}): Promise<PreparedRunContext & { pathContext: RuntimePathContext }> {
  const {
    message,
    responder,
    platform,
    conversationId,
    conversationDir,
    sessionUuid,
    runState,
    executor,
    executionResolver,
    resolveExecutorForRun,
    getPathContext,
    session,
    setEventContext,
    setSandboxContext,
    setUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
  } = params;
  let pathContext = params.pathContext;
  const sessionConversation = message.sessionKey.split(":")[0];

  await mkdir(join(conversationDir, "scratch"), { recursive: true });

  if (executionResolver) {
    await resolveExecutorForRun({
      platform: platform.name,
      userId: message.userId,
      conversationId,
      trustModel: platform.trustModel,
    });
    pathContext = getPathContext();
  }

  reloadSessionMessages(session, conversationId);

  const memory = await getMemory(conversationDir);
  const skills = mergeExtensionSkills(
    loadMikanSkills(conversationDir, pathContext.runtimeWorkspaceRoot),
    params.extensionSkills ?? [],
  );
  const triggerAttribution = resolveTriggerAttribution(message);
  const systemPrompt = buildSystemPrompt(
    pathContext.runtimeWorkspaceRoot,
    conversationId,
    message.conversationKind,
    message.userId,
    memory,
    executor.getSandboxConfig(),
    platform,
    skills,
  );
  session.agent.state.systemPrompt = systemPrompt;
  // Cache diagnosis: a byte-stable system prompt is the precondition for
  // provider prompt caching. If this hash changes between turns of one
  // conversation, something turn-varying leaked into the prompt; if it is
  // stable and cacheRead stays 0, the miss is provider-side (e.g. OpenRouter
  // routing the model across upstream hosts). This is the base prompt mikan
  // builds; a `before_agent_start` extension may still rewrite it per turn
  // (logged separately by the runner).
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 8);
  log.logInfo(
    `[${conversationId}] System prompt (base): ${systemPrompt.length} chars, sha ${promptHash}`,
  );

  setEventContext({
    platform: platform.name,
    conversationId,
    conversationKind: message.conversationKind,
    userId: message.userId,
  });
  setSandboxContext({ conversationId, userId: message.userId });

  setUploadFunction(async (filePath: string, title?: string) => {
    const hostPath = translateAttachPathToHost(filePath, pathContext);
    await responder.uploadFile(hostPath, title);
  });

  // The react tool is available only when the responder supports reactions
  // (interactive turns on platforms with reaction support); otherwise unset
  // so the tool reports it is unavailable rather than silently no-op'ing.
  setReactFunction(responder.react ? async (emoji: string) => responder.react!(emoji) : null);

  // Platform capability packs (e.g. GitHub PR/CI) enable themselves per run;
  // core does not branch on platform name here.
  bindPlatformToolPacks({ conversationId, platformName: platform.name });

  resetRunState(
    runState,
    responder,
    sessionConversation,
    message.userName,
    sessionUuid,
    triggerAttribution,
  );
  const runQueue = createRunQueue(responder, runState);
  runState.queue = runQueue.queue;

  log.logInfo(
    `Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`,
  );
  log.logInfo(`Channels: ${platform.channels.length}, Users: ${platform.users.length}`);

  const { userMessage, imageAttachments } = buildPromptPayload(
    message,
    pathContext.runtimeWorkspaceRoot,
    pathContext,
  );
  const turnInstructions = buildTurnInstructions(
    message.id.startsWith("event:"),
    triggerAttribution,
    platform.name,
  );
  const finalUserMessage = turnInstructions ? `${turnInstructions}\n\n${userMessage}` : userMessage;
  await writePromptDebugContext(
    conversationDir,
    systemPrompt,
    session,
    finalUserMessage,
    imageAttachments.length,
  );

  return {
    sessionConversation,
    runQueue,
    userMessage: finalUserMessage,
    imageAttachments,
    triggerAttribution,
    pathContext,
  };
}

function formatAgentActorName(userName: string | undefined, fallback: string): string {
  return userName ? `DM:${userName}` : fallback;
}

function sendAgentEvent(payload: {
  sessionId: string;
  actorName: string;
  event: AgentEventPayload;
}): void {
  emitAgentEvent({ source: "mikan", ...payload });
}

// ponytail: additive SSE mirror only; keep responder rendering here until another frontend needs the same stream.
function attachSessionEventHandlers(params: {
  session: MikanAgentSession;
  runState: RunnerSessionState;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
}): void {
  const { session, runState, model, agentConfig } = params;
  session.subscribe(async (event) => {
    if (!runState.responder || !runState.logCtx || !runState.queue) return;

    const { responder, logCtx, queue, pendingTools } = runState;
    const baseAttrs = { channel_id: logCtx.conversationId, session_id: logCtx.sessionId };
    const agentEventSessionId = logCtx.sessionId ?? logCtx.conversationId;

    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as { label?: string };
      const label = args.label || event.toolName;
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: {
          kind: "toolStart",
          toolId: event.toolCallId,
          toolName: event.toolName,
          input: { label },
        },
      });

      pendingTools.set(event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
        startTime: Date.now(),
      });
      runState.toolProgress.set(event.toolCallId, {
        label: extractToolLabel(event.toolName, event.args),
        status: "running",
      });
      queue.enqueue(
        () => replaceResponseWithToolProgress(responder, runState),
        "tool progress update",
      );
      addLifecycleBreadcrumb("agent.tool.started", {
        tool: event.toolName,
        ...baseAttrs,
      });

      log.logToolStart(logCtx, event.toolName, label, event.args as Record<string, unknown>);
      return;
    }

    if (event.type === "tool_execution_end") {
      const resultStr = extractToolResultText(event.result);
      const pending = pendingTools.get(event.toolCallId);
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "toolEnd", toolId: event.toolCallId },
      });
      const progress = runState.toolProgress.get(event.toolCallId);
      if (progress) progress.status = event.isError ? "error" : "done";
      queue.enqueue(
        () => replaceResponseWithToolProgress(responder, runState),
        "tool progress update",
      );
      pendingTools.delete(event.toolCallId);
      const durationMs = pending ? Date.now() - pending.startTime : 0;

      Sentry.metrics.count("agent.tool.calls", 1, {
        attributes: metricAttributes({
          tool: event.toolName,
          error: String(event.isError),
          ...baseAttrs,
        }),
      });
      Sentry.metrics.distribution("agent.tool.duration", durationMs, {
        unit: "millisecond",
        attributes: metricAttributes({
          tool: event.toolName,
          ...baseAttrs,
        }),
      });
      addLifecycleBreadcrumb("agent.tool.completed", {
        tool: event.toolName,
        error: event.isError,
        duration_ms: durationMs,
        ...baseAttrs,
      });

      if (event.isError) {
        log.logToolError(logCtx, event.toolName, durationMs, resultStr);
      } else {
        log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
      }

      return;
    }

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        runState.llmCallCount += 1;
        sendAgentEvent({
          sessionId: agentEventSessionId,
          actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
          event: { kind: "sessionStart" },
        });
        addLifecycleBreadcrumb("agent.llm.call.started", {
          call_index: runState.llmCallCount,
          provider: model.provider,
          model: agentConfig.model,
          ...baseAttrs,
        });
        log.logResponseStart(logCtx);
      }
      return;
    }

    if (event.type === "message_update") {
      const assistantMessageEvent = (
        event as {
          assistantMessageEvent?: { type?: string; delta?: string };
        }
      ).assistantMessageEvent;
      if (assistantMessageEvent?.type === "text_delta" && assistantMessageEvent.delta) {
        sendAgentEvent({
          sessionId: agentEventSessionId,
          actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
          event: { kind: "responseDelta", delta: assistantMessageEvent.delta },
        });
        if (responder.appendResponseDelta) {
          queue.enqueue(async () => {
            await responder.appendResponseDelta?.(assistantMessageEvent.delta ?? "");
          }, "response delta");
        }
      }
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const assistantMsg = event.message;

        if (assistantMsg.stopReason) {
          runState.stopReason = assistantMsg.stopReason;
        }
        if (assistantMsg.errorMessage) {
          runState.errorMessage = assistantMsg.errorMessage;
        }

        if (assistantMsg.usage) {
          runState.totalUsage.input += assistantMsg.usage.input;
          runState.totalUsage.output += assistantMsg.usage.output;
          runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
          runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
          runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
          runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
          runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
          runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
          runState.totalUsage.cost.total += assistantMsg.usage.cost.total;

          const llmAttributes = metricAttributes({
            provider: model.provider,
            model: agentConfig.model,
            ...baseAttrs,
            stop_reason: assistantMsg.stopReason,
            error: Boolean(assistantMsg.errorMessage),
          });
          Sentry.metrics.count("agent.llm.calls", 1, { attributes: llmAttributes });
          Sentry.metrics.distribution("agent.llm.tokens_in", assistantMsg.usage.input, {
            attributes: llmAttributes,
          });
          Sentry.metrics.distribution("agent.llm.tokens_out", assistantMsg.usage.output, {
            attributes: llmAttributes,
          });
          if (assistantMsg.usage.cacheRead > 0) {
            Sentry.metrics.distribution("agent.llm.cache_read", assistantMsg.usage.cacheRead, {
              attributes: llmAttributes,
            });
          }
          if (assistantMsg.usage.cacheWrite > 0) {
            Sentry.metrics.distribution("agent.llm.cache_write", assistantMsg.usage.cacheWrite, {
              attributes: llmAttributes,
            });
          }
          Sentry.metrics.distribution("agent.llm.cost_per_turn", assistantMsg.usage.cost.total, {
            attributes: llmAttributes,
          });
          addLifecycleBreadcrumb("agent.llm.call.completed", {
            call_index: runState.llmCallCount,
            provider: model.provider,
            model: agentConfig.model,
            stop_reason: assistantMsg.stopReason,
            error: Boolean(assistantMsg.errorMessage),
            input_tokens: assistantMsg.usage.input,
            output_tokens: assistantMsg.usage.output,
            cost_total_usd: assistantMsg.usage.cost.total,
          });
        }

        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        const hasToolCall = assistantMsg.content.some((part) =>
          ["tool_use", "toolCall", "tool-call"].includes((part as { type?: string }).type ?? ""),
        );
        for (const part of assistantMsg.content) {
          if (part.type === "thinking") {
            thinkingParts.push(part.thinking);
          } else if (part.type === "text") {
            textParts.push(part.text);
          }
        }

        const text = textParts.join("\n");

        for (const thinking of thinkingParts) {
          log.logThinking(logCtx, thinking);
          queue.enqueue(() => responder.respond(`_${thinking}_`), "thinking main");
          queue.enqueue(() => responder.respondDiagnostic(`_${thinking}_`), "thinking diagnostic");
        }

        if (text.trim() && !hasToolCall) {
          if (runState.finalResponseHandledByTool) return;
          const finalText = appendTriggerAttribution(
            formatResponseWithToolProgress(text, runState),
            runState.triggerAttribution,
          );
          log.logResponse(logCtx, text);
          sendAgentEvent({
            sessionId: agentEventSessionId,
            actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
            event: { kind: "responseFinal", text: finalText },
          });
          sendAgentEvent({
            sessionId: agentEventSessionId,
            actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
            event: { kind: "turnEnd" },
          });
          if (responder.finishResponse) {
            queue.enqueue(async () => {
              await responder.finishResponse?.(finalText);
            }, "response finish");
          } else {
            queue.enqueue(() => responder.respond(finalText), "response main");
          }
        }
      }
      return;
    }

    if (event.type === "compaction_start") {
      const text = "_Compacting context..._";
      log.logInfo(`Auto-compaction started (reason: ${event.reason})`);
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "diagnostic", text },
      });
      queue.enqueue(() => responder.respond(text), "compaction start");
      return;
    }

    if (event.type === "compaction_end") {
      if (event.result) {
        log.logInfo(`Auto-compaction complete: ${event.result.tokensBefore} tokens compacted`);
      } else if (event.aborted) {
        log.logInfo("Auto-compaction aborted");
      }
      return;
    }

    if (event.type === "auto_retry_start") {
      log.logWarning(`Retrying (${event.attempt}/${event.maxAttempts})`, event.errorMessage);
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "sessionStart" },
      });
      const text = `_Retrying (${event.attempt}/${event.maxAttempts})..._`;
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "diagnostic", text },
      });
      queue.enqueue(() => responder.respond(text), "retry");
    }

    if (event.type === "budget_exceeded") {
      log.logWarning(
        "Run stopped by budget circuit breaker",
        `${event.reason} (tokens=${event.tokens}, cost=${event.costUsd.toFixed(2)}, calls=${event.llmCalls}, ${event.durationMs}ms)`,
      );
      const text = `_Stopped: run budget exceeded (${event.reason})_`;
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "diagnostic", text },
      });
      queue.enqueue(() => responder.respondDiagnostic(text, { style: "error" }), "budget exceeded");
    }
  });
}

/**
 * Create a new PiAgentWrapper for a channel.
 * Sets up the session and subscribes to events once.
 *
 * Runner caching is handled by the caller (channelStates in main.ts).
 * This is a stateless factory function.
 */
export async function createRunner(
  sandboxConfig: SandboxConfig,
  sessionKey: string,
  conversationId: string,
  conversationDir: string,
  workspaceDir: string,
  sessionScope: ResolvedSessionScope,
  vaultManager?: VaultManager,
  provisioner?: DockerContainerManager,
  sessionView?: {
    tokenStore: SessionViewTokenStoreLike;
    portalBaseUrl?: string;
  },
  platformNotifier?: PlatformNotifier,
  platformReactor?: PlatformReactor,
  platformToolPackFactories?: readonly PlatformToolPackFactory[],
): Promise<PiAgentWrapper> {
  const agentConfig = resolveConversationSettings(conversationDir);

  const workspaceBase = join(conversationDir, "..");
  const { executionResolver, executor, getPathContext, resolveExecutorForRun } =
    createRunnerExecutionContext(
      sandboxConfig,
      vaultManager,
      provisioner,
      workspaceDir,
      workspaceBase,
    );
  let pathContext = getUnresolvedSandboxPathContext(sandboxConfig, workspaceBase);

  // Create tools (per-runner, with per-runner upload function setter)
  const {
    tools,
    setUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
    setEventContext,
    setSandboxContext,
  } = createMikanTools(
    executor,
    workspaceDir,
    { sandbox: sandboxConfig, provisioner },
    platformToolPackFactories ?? [],
  );

  const modelRegistry = MikanModels.create();
  if (modelRegistry.getError()) {
    log.logWarning("models.json load error", modelRegistry.getError()!);
  }
  const model = resolveConfiguredModel(modelRegistry, agentConfig.provider, agentConfig.model);

  // Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
  const memory = await getMemory(conversationDir);
  const skills = loadMikanSkills(conversationDir, pathContext.runtimeWorkspaceRoot);
  const emptyPlatform: MessagingInfo = {
    name: "chat",
    formattingGuide: "",
    channels: [],
    users: [],
    trustModel: "membership",
  };
  const systemPrompt = buildSystemPrompt(
    pathContext.runtimeWorkspaceRoot,
    conversationId,
    "shared",
    undefined,
    memory,
    sandboxConfig,
    emptyPlatform,
    skills,
  );

  // Create session manager and settings manager. Top-level/private sessions
  // use the conversation's current pointer; scoped sessions use fixed files.
  // Platform-specific scope behavior is resolved before runner creation.
  const isThread = sessionKey.includes(":");
  const { contextFile, threadRootMessage } = sessionScope;
  const sessionManager = openManagedSession(contextFile, pathContext.runtimeWorkspaceRoot);
  const threadSessionName = buildThreadSessionName(threadRootMessage);
  if (isThread && threadSessionName && sessionManager.getSessionName() !== threadSessionName) {
    sessionManager.appendSessionInfo(threadSessionName);
  }

  const sessionUuid = extractSessionUuid(contextFile);
  const chatSessionManager = new AgentMemoryFileManager();
  const { session, extensionSkills } = await createConfiguredAgentSession({
    conversationId,
    workspaceDir,
    systemPrompt,
    model,
    thinkingLevel: agentConfig.thinkingLevel,
    tools,
    sessionStore: sessionManager,
    models: modelRegistry,
    vaultManager,
    platformNotifier,
    platformReactor,
  });

  // Mutable per-run state - event handler references this
  const runState = createRunState();
  attachSessionEventHandlers({ session, runState, model, agentConfig });

  return {
    syncChatHistory(currentMessageId?: string): void {
      chatSessionManager.syncSessionManager({
        conversationDir,
        sessionKey,
        sessionManager,
        currentMessageId,
      });
    },

    async run(
      message: ConversationMessage,
      responder: ConversationResponder,
      platform: MessagingInfo,
    ): Promise<{ stopReason: string; errorMessage?: string }> {
      const prepared = await prepareRunContext({
        message,
        responder,
        platform,
        conversationId,
        conversationDir,
        sessionUuid,
        runState,
        executor,
        executionResolver,
        resolveExecutorForRun,
        getPathContext,
        session,
        extensionSkills,
        setEventContext,
        setSandboxContext,
        setUploadFunction,
        setReactFunction,
        bindPlatformToolPacks,
        pathContext,
      });
      pathContext = prepared.pathContext;

      if (runState.logCtx) {
        log.logAgentRunStart(runState.logCtx, model.provider, model.id, model.name);
      }

      updateActiveSpanAttribution({
        provider: model.provider,
        model: agentConfig.model,
        channel_id: prepared.sessionConversation,
        session_id: sessionUuid,
      });
      addLifecycleBreadcrumb("agent.prompt.sent", {
        provider: model.provider,
        model: agentConfig.model,
        channel_id: prepared.sessionConversation,
        session_id: sessionUuid,
        attachment_count: message.attachments?.length ?? 0,
        image_attachment_count: prepared.imageAttachments.length,
      });
      sendAgentEvent({
        sessionId: sessionUuid,
        actorName: formatAgentActorName(message.userName, prepared.sessionConversation),
        event: { kind: "sessionStart" },
      });

      // Autonomous (event/trigger) runs get an explicit resource ceiling since
      // no human is watching the loop; interactive turns stay human-gated.
      const isEventRun = message.id.startsWith("event:");
      await session.prompt(prepared.userMessage, {
        ...(prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : {}),
        ...(isEventRun ? { budget: DEFAULT_EVENT_BUDGET } : {}),
      });

      // Wait for queued messages
      await prepared.runQueue.wait();

      const sessionViewTokenStore = sessionView?.tokenStore;
      const sessionViewPortalBaseUrl = sessionView?.portalBaseUrl;
      let sessionViewLink: string | undefined;
      const createSessionViewLink =
        sessionViewTokenStore && sessionViewPortalBaseUrl
          ? () => {
              if (!sessionViewLink) {
                const token = sessionViewTokenStore.create(
                  platform.name as PlatformName,
                  message.userId,
                  conversationId,
                  message.sessionKey,
                  contextFile,
                  message.userName,
                );
                sessionViewLink = `${sessionViewPortalBaseUrl}/session?token=${token.token}`;
              }
              return sessionViewLink;
            }
          : undefined;

      await finalizeRunResponse(responder, session, runState, {
        triggerAttribution: prepared.triggerAttribution,
        triggerSessionLink: isEventTriggerAttribution(prepared.triggerAttribution)
          ? createSessionViewLink?.()
          : undefined,
        createOverflowLink: createSessionViewLink,
        platform: platform.name,
        model,
        sessionConversation: prepared.sessionConversation,
        sessionUuid,
      });

      await reportUsageSummary({
        session,
        runState,
        responder,
        platform,
        model,
        agentConfig,
        sessionConversation: prepared.sessionConversation,
        sessionUuid,
        waitForQueue: () => prepared.runQueue.wait(),
      });

      // Clear run state
      runState.responder = null;
      runState.logCtx = null;
      runState.queue = null;

      return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
    },

    abort(): void {
      session.abort();
    },

    getCurrentStep(): { toolName?: string; label?: string } | undefined {
      const pending = runState.pendingTools;
      if (pending.size === 0) return undefined;
      // Get the first pending tool
      const first = pending.values().next().value;
      if (!first) return undefined;
      return {
        toolName: first.toolName,
        label: (first.args as { label?: string })?.label,
      };
    },
  };
}
