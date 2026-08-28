import type { CreateRunnerOptions, OfficeAddress, PiAgentWrapper } from "../types.js";
import type { Office } from "../office/index.js";
import type { MikanAgentSession } from "../harness/index.js";
import {
  DEFAULT_EVENT_BUDGET,
  type ExtensionBlockAction,
  type ExtensionScheduleCallbackEvent,
  MikanModels,
  type MikanSkill,
  parseCommandInput,
  type RunOrigin,
} from "../harness/index.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type {
  ConversationKind,
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
  PlatformName,
} from "../adapter.js";
import { resolveConversationSettings } from "../config.js";
import { resolveWorkspaceProjection } from "../workspace-projection/index.js";
import type { ActorExecutionResolver } from "../execution-resolver.js";
import * as log from "../log.js";
import { loadMcpTools } from "../mcp/loader.js";
import {
  assertSandboxSupportsWorkspacePolicy,
  getUnresolvedSandboxPathContext,
  type Executor,
  type RuntimePathContext,
} from "../sandbox/index.js";
import { addLifecycleBreadcrumb, updateActiveSpanAttribution } from "../observability/sentry.js";
import { ChatHistorySync } from "../sessions/chat-history-sync.js";
import { conversationIdOf, isThreadSessionKey } from "../sessions/session-key.js";
import {
  extractSessionUuid,
  openManagedSession,
  type ThreadRootMessage,
} from "../sessions/store.js";
import { createMikanTools } from "../tools/index.js";
import type { PlatformToolRunContext } from "../tools/types.js";
import { createConfiguredAgentSession, loadMikanSkills, mergeExtensionSkills } from "./catalog.js";
import {
  createRunnerExecutionContext,
  normalizeAttachRuntimePath,
  withStagedRuntimeFile,
} from "./execution.js";
import {
  buildPromptPayload,
  buildSystemPrompt,
  buildTurnInstructions,
  getMemory,
  resolveTriggerAttribution,
  SESSION_DREAM_BUDGET,
  sessionDreamPrompt,
  sessionDreamTools,
} from "./prompt.js";
import {
  attachSessionEventHandlers,
  createNoopResponder,
  createRunQueue,
  createRunState,
  finalizeRunResponse,
  formatAgentActorName,
  isEventTriggerAttribution,
  reportUsageSummary,
  resetRunState,
  sendAgentEvent,
} from "./presenter.js";

import type { PreparedRunContext, RunnerExecutionContext, RunnerSessionState } from "./types.js";

function buildThreadSessionName(message: ThreadRootMessage | null): string | undefined {
  const text = message?.text?.trim();
  if (!text) return undefined;
  const userLabel = message?.userName || message?.user || "unknown";
  return `[${userLabel}]: ${text}`;
}

async function reloadSessionMessages(
  session: MikanAgentSession,
  conversationId: string,
): Promise<void> {
  const reloaded = await session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from context`);
  }
}

async function prepareRunContext(params: {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
  office: Office;
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
  setSandboxContext: (context: { address: OfficeAddress; userId: string }) => void;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setImageUploadFunction: (fn: (hostPath: string, title?: string) => Promise<void>) => void;
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  bindPlatformToolPacks: (ctx: PlatformToolRunContext) => void;
  pathContext: RuntimePathContext;
}): Promise<PreparedRunContext & { pathContext: RuntimePathContext }> {
  const {
    message,
    responder,
    platform,
    office,
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
    setImageUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
  } = params;
  const conversationId = office.address.conversationId;
  let pathContext = params.pathContext;
  const sessionConversation = conversationIdOf(message.sessionKey);

  await mkdir(join(office.dir, "scratch"), { recursive: true });

  if (executionResolver) {
    await resolveExecutorForRun({
      address: message.address,
      userId: message.userId,
      trustModel: platform.trustModel,
    });
    pathContext = getPathContext();
  }

  await reloadSessionMessages(session, conversationId);

  const projection = resolveWorkspaceProjection(office);
  const memory = await getMemory(projection);
  const conversationSkillLoad = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
  );
  const skills = mergeExtensionSkills(conversationSkillLoad.skills, params.extensionSkills ?? []);
  const triggerAttribution = resolveTriggerAttribution(message);
  const systemPrompt = buildSystemPrompt(
    pathContext.runtimeWorkspaceRoot,
    office,
    message.conversationKind,
    message.userId,
    memory,
    executor.getSandboxConfig(),
    platform,
    skills,
    projection,
    conversationSkillLoad.skippedSkillLinks,
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
  setSandboxContext({ address: message.address, userId: message.userId });

  setUploadFunction(async (filePath: string, title?: string) => {
    const runtimePath = normalizeAttachRuntimePath(filePath, pathContext.runtimeWorkspaceRoot);
    await withStagedRuntimeFile(executor, runtimePath, (stagedPath) =>
      responder.uploadFile(stagedPath, title),
    );
  });

  // generate_image writes its file host-side, so it uploads by host path —
  // no staging through the sandbox, where the file may not be mounted.
  setImageUploadFunction(async (hostPath: string, title?: string) => {
    await responder.uploadFile(hostPath, title);
  });

  // The react tool is available only when the responder supports reactions
  // (interactive turns on platforms with reaction support); otherwise unset
  // so the tool reports it is unavailable rather than silently no-op'ing.
  setReactFunction(responder.react ? async (emoji: string) => responder.react!(emoji) : null);

  // Platform capability packs (e.g. GitHub PR/CI) enable themselves per run;
  // core does not branch on platform name here.
  bindPlatformToolPacks({
    conversationId,
    platformName: platform.name,
    threadTs: message.threadTs,
  });

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

  const { userMessage, imageAttachments } = await buildPromptPayload(
    message,
    pathContext.runtimeWorkspaceRoot,
    pathContext,
    (runtimePath) => executor.readFileBase64(runtimePath),
  );
  const turnInstructions = buildTurnInstructions(
    message.id.startsWith("event:"),
    triggerAttribution,
    platform.name,
  );
  const finalUserMessage = turnInstructions ? `${turnInstructions}\n\n${userMessage}` : userMessage;
  return {
    sessionConversation,
    runQueue,
    userMessage: finalUserMessage,
    imageAttachments,
    triggerAttribution,
    pathContext,
  };
}

/**
 * The dream run reads a transcript in which the agent held its full tool set,
 * but `sessionDreamTools` has since narrowed it. Left to infer its grant from
 * the transcript, the model calls a tool it no longer holds and burns one of
 * its five turns on the failure — so the grant is stated, and derived from the
 * tools actually handed to the run rather than restated by hand.
 */
export async function createRunner(options: CreateRunnerOptions): Promise<PiAgentWrapper> {
  const {
    sandboxConfig,
    sessionKey,
    office,
    sessionScope,
    vaultManager,
    provisioner,
    resourceController,
    sessionView,
    platformNotifier,
    platformReactor,
    platformUploader,
    platformBlockKit,
    platformDmOpener,
    platformHistoryFetcher,
    platformUserLister,
    extensionScheduleEngine,
    platformToolPackFactories,
  } = options;
  const conversationId = office.address.conversationId;
  const conversationDir = office.dir;
  const workspaceDir = office.workspace.root;
  const agentConfig = resolveConversationSettings(office);

  const projection = resolveWorkspaceProjection(office);
  assertSandboxSupportsWorkspacePolicy(
    sandboxConfig,
    projection.doorPolicy,
    projection.promptSources.globalMemoryReadOnly === true,
  );
  const { executionResolver, executor, getPathContext, resolveExecutorForRun } =
    createRunnerExecutionContext(sandboxConfig, vaultManager, provisioner, office.workspace);
  let pathContext = getUnresolvedSandboxPathContext(sandboxConfig, workspaceDir);

  const modelRegistry = options.models ?? MikanModels.create();
  if (modelRegistry.getError()) {
    log.logWarning("models.json load error", modelRegistry.getError()!);
  }
  const model = modelRegistry.resolve(agentConfig.provider, agentConfig.model);

  // Create tools (per-runner, with per-runner upload function setter)
  const {
    tools,
    setUploadFunction,
    setImageUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
    setEventContext,
    setSandboxContext,
  } = createMikanTools(
    executor,
    workspaceDir,
    { sandbox: sandboxConfig, resourceController: resourceController ?? provisioner },
    platformToolPackFactories ?? [],
    {
      model,
      getApiKey: () => modelRegistry.getApiKeyForProvider(model.provider),
      // The conversation's own office dir: mounted into the sandbox, unlike
      // the workspace base — generated images must land somewhere the agent
      // (and a future run) can still reach.
      outputDir: conversationDir,
    },
  );

  // Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
  const memory = await getMemory(projection);
  const { skills, skippedSkillLinks } = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
  );
  const emptyPlatform: MessagingInfo = {
    name: "chat",
    formattingGuide: "",
    channels: [],
    users: [],
    trustModel: "membership",
  };
  const systemPrompt = buildSystemPrompt(
    pathContext.runtimeWorkspaceRoot,
    office,
    "shared",
    undefined,
    memory,
    sandboxConfig,
    emptyPlatform,
    skills,
    projection,
    skippedSkillLinks,
  );

  // Create session manager and settings manager. Top-level/private sessions
  // use the conversation's current pointer; scoped sessions use fixed files.
  // Platform-specific scope behavior is resolved before runner creation.
  const isThread = isThreadSessionKey(sessionKey);
  const { contextFile, threadRootMessage } = sessionScope;
  const sessionManager = await openManagedSession(contextFile, pathContext.runtimeWorkspaceRoot);
  const threadSessionName = buildThreadSessionName(threadRootMessage);
  if (
    isThread &&
    threadSessionName &&
    (await sessionManager.getSessionName()) !== threadSessionName
  ) {
    await sessionManager.setSessionName(threadSessionName);
  }

  const sessionUuid = extractSessionUuid(contextFile);
  const chatSessionManager = new ChatHistorySync();

  // MCP tools run host-side: credentials live in server config (settings) and
  // the server process, never in the sandbox or the model's context. Loaded
  // per-runner so a settings change is picked up on the next runner build.
  const mcpResult = await loadMcpTools(agentConfig.mcpServers ?? {});
  for (const mcpError of mcpResult.errors) {
    log.logWarning(
      `[${conversationId}] MCP server unavailable: ${mcpError.server}`,
      mcpError.error,
    );
  }
  if (mcpResult.tools.length > 0) {
    log.logInfo(`[${conversationId}] Loaded ${mcpResult.tools.length} MCP tool(s)`);
  }
  const toolsWithMcp = [...tools, ...mcpResult.tools];

  const { session, extensionSkills, extensionRegistry, disposeExtensions } =
    await createConfiguredAgentSession({
      office,
      systemPrompt,
      model,
      thinkingLevel: agentConfig.thinkingLevel,
      tools: toolsWithMcp,
      sessionStore: sessionManager,
      models: modelRegistry,
      vaultManager,
      platformNotifier,
      platformReactor,
      platformUploader,
      platformBlockKit,
      platformDmOpener,
      platformHistoryFetcher,
      platformUserLister,
      extensionScheduleEngine,
    });

  // Mutable per-run state - event handler references this
  const runState = createRunState();
  attachSessionEventHandlers({ session, runState, model, agentConfig });

  return {
    async syncChatHistory(currentMessageId?: string): Promise<void> {
      await chatSessionManager.syncSessionManager({
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
        office,
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
        setImageUploadFunction,
        setReactFunction,
        bindPlatformToolPacks,
        pathContext,
      });
      pathContext = prepared.pathContext;

      try {
        return await runPreparedTurn();
      } finally {
        // Ownership must return to the pool on every exit — a throw anywhere
        // in the turn (dreamSessionMemory already does this) would otherwise
        // leave the runner permanently "busy" with a stale responder.
        runState.responder = null;
        runState.logCtx = null;
        runState.queue = null;
      }

      async function runPreparedTurn(): Promise<{ stopReason: string; errorMessage?: string }> {
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
        // Event runs have no triggering platform message, so identity fields
        // stay unset and extensions must null-check them.
        const origin: RunOrigin = isEventRun
          ? { kind: "event", platform: platform.name }
          : {
              kind: "interactive",
              platform: platform.name,
              messageTs: message.id,
              userId: message.userId,
              userName: message.userName,
              threadTs: message.threadTs,
              attachments: message.attachments,
            };
        const outcome = await session.prompt(prepared.userMessage, {
          origin,
          ...(prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : {}),
          ...(isEventRun ? { budget: DEFAULT_EVENT_BUDGET } : {}),
        });

        if (outcome?.blocked) {
          const text = outcome.reason
            ? `_Turn blocked by an extension: ${outcome.reason}_`
            : "_Turn blocked by an extension._";
          sendAgentEvent({
            sessionId: sessionUuid,
            actorName: formatAgentActorName(message.userName, prepared.sessionConversation),
            event: { kind: "diagnostic", text },
          });
          await responder.respondDiagnostic(text, { style: "muted" });
          return { stopReason: "blocked" };
        }

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

        return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
      }
    },

    async dreamSessionMemory(
      message: ConversationMessage,
      platform: MessagingInfo,
    ): Promise<{ stopReason: string; errorMessage?: string }> {
      const responder = createNoopResponder();
      const prepared = await prepareRunContext({
        message,
        responder,
        platform,
        office,
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
        setImageUploadFunction,
        setReactFunction,
        bindPlatformToolPacks,
        pathContext,
      });
      pathContext = prepared.pathContext;

      try {
        const conversationMemoryPath = posix.join(
          prepared.pathContext.runtimeWorkspaceRoot,
          office.key,
          "MEMORY.md",
        );
        const dreamTools = sessionDreamTools(session.agent.state.tools, conversationMemoryPath);
        const outcome = await session.prompt(
          sessionDreamPrompt(
            conversationMemoryPath,
            dreamTools.map((tool) => tool.name),
          ),
          {
            origin: {
              kind: "interactive",
              platform: platform.name,
              messageTs: message.id,
              userId: message.userId,
              userName: message.userName,
              threadTs: message.threadTs,
              attachments: message.attachments,
            },
            budget: SESSION_DREAM_BUDGET,
            tools: dreamTools,
          },
        );
        if (outcome?.blocked) {
          return { stopReason: "blocked", errorMessage: outcome.reason };
        }
        await prepared.runQueue.wait();
        // A budget abort carries its reason in the tally, not in errorMessage,
        // and that reason is the only thing that tells the user why memory was
        // not preserved.
        return {
          stopReason: runState.stopReason,
          errorMessage: runState.errorMessage ?? session.getLastRunStats().budgetExceededReason,
        };
      } finally {
        runState.responder = null;
        runState.logCtx = null;
        runState.queue = null;
      }
    },

    abort(): void {
      session.abort();
    },

    async tryExtensionCommand(
      message: ConversationMessage,
      responder: ConversationResponder,
      parseOptions: { bareName?: boolean } = {},
    ): Promise<boolean> {
      const parsed = parseCommandInput(message.text, parseOptions);
      if (!parsed) return false;
      return extensionRegistry.dispatchCommand(parsed.name, {
        args: parsed.args,
        conversationId,
        userId: message.userId,
        userName: message.userName,
        threadTs: message.threadTs,
        respond: (text: string) => responder.respond(text),
      });
    },

    async tryExtensionAction(slug: string, action: ExtensionBlockAction): Promise<boolean> {
      return extensionRegistry.dispatchAction(slug, action);
    },

    async tryExtensionScheduleCallback(
      slug: string,
      callback: string,
      event: ExtensionScheduleCallbackEvent,
    ): Promise<boolean> {
      return extensionRegistry.dispatchScheduleCallback(slug, callback, event);
    },

    async dispose(): Promise<void> {
      try {
        await disposeExtensions();
      } finally {
        try {
          await mcpResult.dispose();
        } finally {
          await sessionManager.close();
        }
      }
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
