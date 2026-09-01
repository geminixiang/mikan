import type { CreateRunnerOptions, OfficeAddress, PiAgentWrapper } from "../types.js";
import type { Office } from "../office/index.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { MikanAgentSession } from "../harness/index.js";
import { DEFAULT_EVENT_BUDGET, MikanModels } from "../harness/index.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConversationKind,
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
  PlatformName,
} from "../adapter.js";
import { resolveConversationSettings } from "../config.js";
import { resolveConversationPackages } from "../packages/index.js";
import { resolveWorkspaceProjection } from "../workspace-projection/index.js";
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
import { createConfiguredAgentSession, loadMikanSkills } from "./catalog.js";
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
} from "./prompt.js";
import {
  attachSessionEventHandlers,
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

type PrepareRunParams = {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
  office: Office;
  sessionUuid: string;
  runState: RunnerSessionState;
  executor: Executor;
  resolveForRun: RunnerExecutionContext["resolveForRun"];
  session: MikanAgentSession;
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
};

type RunPromptContext = {
  pathContext: RuntimePathContext;
  memory: string;
  systemPrompt: string;
  triggerAttribution: string | undefined;
};

async function preparePromptContext(params: PrepareRunParams): Promise<RunPromptContext> {
  const { message, platform, office, executor, resolveForRun, session } = params;
  const conversationId = office.address.conversationId;
  const decision = await resolveForRun({
    address: message.address,
    userId: message.userId,
    trustModel: platform.trustModel,
  });
  const { pathContext, projection, packages } = decision;
  for (const error of packages.errors) {
    log.logWarning(`Package unavailable: ${error.source}`, error.message);
  }

  const reloaded = await session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from context`);
  }

  const memory = await getMemory(projection);
  const conversationSkillLoad = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
    packages,
  );
  const triggerAttribution = resolveTriggerAttribution(message);
  const systemPrompt = buildSystemPrompt({
    workspacePath: pathContext.runtimeWorkspaceRoot,
    office,
    memory,
    sandboxConfig: executor.getSandboxConfig(),
    platform,
    skills: conversationSkillLoad.skills,
    projection,
    skippedSkillLinks: conversationSkillLoad.skippedSkillLinks,
  });
  session.agent.state.systemPrompt = systemPrompt;
  // A stable hash across turns verifies that turn-specific data did not leak
  // into the provider-cacheable system prompt.
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 8);
  log.logInfo(
    `[${conversationId}] System prompt (base): ${systemPrompt.length} chars, sha ${promptHash}`,
  );
  return { pathContext, memory, systemPrompt, triggerAttribution };
}

function bindRunCapabilities(params: PrepareRunParams, pathContext: RuntimePathContext): void {
  const {
    message,
    responder,
    platform,
    office,
    executor,
    setEventContext,
    setSandboxContext,
    setUploadFunction,
    setImageUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
  } = params;
  setEventContext({
    platform: platform.name,
    conversationId: office.address.conversationId,
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
  // Generated images already live host-side and must not be staged through a sandbox.
  setImageUploadFunction(async (hostPath: string, title?: string) => {
    await responder.uploadFile(hostPath, title);
  });
  // Unset reaction support when the active responder cannot react.
  setReactFunction(responder.react ? async (emoji: string) => responder.react!(emoji) : null);
  bindPlatformToolPacks({
    conversationId: office.address.conversationId,
    platformName: platform.name,
    threadTs: message.threadTs,
  });
}

async function prepareRunContext(params: PrepareRunParams): Promise<PreparedRunContext> {
  const { message, responder, platform, office, sessionUuid, runState, executor } = params;
  const sessionConversation = conversationIdOf(message.sessionKey);
  await mkdir(join(office.dir, "scratch"), { recursive: true });
  const { pathContext, memory, systemPrompt, triggerAttribution } =
    await preparePromptContext(params);
  bindRunCapabilities(params, pathContext);

  resetRunState(runState, {
    responder,
    sessionConversation,
    userName: message.userName,
    sessionUuid,
    triggerAttribution,
  });
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
  };
}

async function buildInitialSystemPrompt(params: {
  office: Office;
  pathContext: RuntimePathContext;
  projection: ReturnType<typeof resolveWorkspaceProjection>;
  sandboxConfig: CreateRunnerOptions["sandboxConfig"];
}): Promise<string> {
  const { office, pathContext, projection, sandboxConfig } = params;
  const memory = await getMemory(projection);
  const { skills, skippedSkillLinks } = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
    resolveConversationPackages({ office }),
  );
  return buildSystemPrompt({
    workspacePath: pathContext.runtimeWorkspaceRoot,
    office,
    memory,
    sandboxConfig,
    platform: {
      name: "chat",
      formattingGuide: "",
      channels: [],
      users: [],
      trustModel: "membership",
    },
    skills,
    projection,
    skippedSkillLinks,
  });
}

async function openRunnerSessionManager(params: {
  contextFile: string;
  runtimeWorkspaceRoot: string;
  sessionKey: string;
  threadRootMessage: ThreadRootMessage | null;
}) {
  const { contextFile, runtimeWorkspaceRoot, sessionKey, threadRootMessage } = params;
  const sessionManager = await openManagedSession(contextFile, runtimeWorkspaceRoot);
  const threadSessionName = buildThreadSessionName(threadRootMessage);
  if (
    isThreadSessionKey(sessionKey) &&
    threadSessionName &&
    (await sessionManager.getSessionName()) !== threadSessionName
  ) {
    await sessionManager.setSessionName(threadSessionName);
  }
  return sessionManager;
}

async function createRunnerAgentSession(params: {
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  tools: ReturnType<typeof createMikanTools>["tools"];
  sessionManager: Awaited<ReturnType<typeof openManagedSession>>;
  modelRegistry: MikanModels;
  conversationId: string;
}) {
  const { workspaceDir, systemPrompt, model, agentConfig, tools, sessionManager, modelRegistry } =
    params;
  const mcpResult = await loadMcpTools(agentConfig.mcpServers ?? {});
  for (const mcpError of mcpResult.errors) {
    log.logWarning(
      `[${params.conversationId}] MCP server unavailable: ${mcpError.server}`,
      mcpError.error,
    );
  }
  if (mcpResult.tools.length > 0) {
    log.logInfo(`[${params.conversationId}] Loaded ${mcpResult.tools.length} MCP tool(s)`);
  }
  const session = await createConfiguredAgentSession({
    workspaceDir,
    systemPrompt,
    model,
    thinkingLevel: agentConfig.thinkingLevel,
    tools: [...tools, ...mcpResult.tools],
    sessionStore: sessionManager,
    models: modelRegistry,
  });
  return { mcpResult, session };
}

type PreparedTurnParams = {
  prepared: PreparedRunContext;
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
  runState: RunnerSessionState;
  session: MikanAgentSession;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionUuid: string;
  conversationId: string;
  contextFile: string;
  sessionView: CreateRunnerOptions["sessionView"];
};

async function runPreparedTurn(params: PreparedTurnParams): Promise<{
  stopReason: string;
  errorMessage?: string;
}> {
  const {
    prepared,
    message,
    responder,
    platform,
    runState,
    session,
    model,
    agentConfig,
    sessionUuid,
    conversationId,
    contextFile,
    sessionView,
  } = params;
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

  const isEventRun = message.id.startsWith("event:");
  await session.prompt(prepared.userMessage, {
    ...(prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : {}),
    ...(isEventRun ? { budget: DEFAULT_EVENT_BUDGET } : {}),
  });
  await prepared.runQueue.wait();

  const sessionViewTokenStore = sessionView?.tokenStore;
  const sessionViewPortalBaseUrl = sessionView?.portalBaseUrl;
  let sessionViewLink: string | undefined;
  const createSessionViewLink =
    sessionViewTokenStore && sessionViewPortalBaseUrl
      ? () => {
          if (!sessionViewLink) {
            const token = sessionViewTokenStore.create({
              platform: platform.name as PlatformName,
              platformUserId: message.userId,
              conversationId,
              sessionKey: message.sessionKey,
              sessionFile: contextFile,
              platformUserName: message.userName,
            });
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

type MikanToolBindings = ReturnType<typeof createMikanTools>;

type RunnerInterfaceParams = {
  conversationId: string;
  conversationDir: string;
  sessionKey: string;
  office: Office;
  sessionUuid: string;
  contextFile: string;
  sessionView: CreateRunnerOptions["sessionView"];
  runState: RunnerSessionState;
  executor: Executor;
  resolveForRun: RunnerExecutionContext["resolveForRun"];
  session: MikanAgentSession;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionManager: Awaited<ReturnType<typeof openManagedSession>>;
  chatSessionManager: ChatHistorySync;
  mcpResult: Awaited<ReturnType<typeof loadMcpTools>>;
  toolBindings: MikanToolBindings;
};

function createRunnerInterface(params: RunnerInterfaceParams): PiAgentWrapper {
  const {
    conversationId,
    conversationDir,
    sessionKey,
    office,
    sessionUuid,
    contextFile,
    sessionView,
    runState,
    executor,
    resolveForRun,
    session,
    model,
    agentConfig,
    sessionManager,
    chatSessionManager,
    mcpResult,
    toolBindings,
  } = params;
  return {
    async syncChatHistory(currentMessageId?: string): Promise<void> {
      await chatSessionManager.syncSessionManager({
        conversationDir,
        sessionKey,
        sessionManager,
        currentMessageId,
      });
    },

    async run(message, responder, platform) {
      const prepared = await prepareRunContext({
        message,
        responder,
        platform,
        office,
        sessionUuid,
        runState,
        executor,
        resolveForRun,
        session,
        setEventContext: toolBindings.setEventContext,
        setSandboxContext: toolBindings.setSandboxContext,
        setUploadFunction: toolBindings.setUploadFunction,
        setImageUploadFunction: toolBindings.setImageUploadFunction,
        setReactFunction: toolBindings.setReactFunction,
        bindPlatformToolPacks: toolBindings.bindPlatformToolPacks,
      });
      try {
        return await runPreparedTurn({
          prepared,
          message,
          responder,
          platform,
          runState,
          session,
          model,
          agentConfig,
          sessionUuid,
          conversationId,
          contextFile,
          sessionView,
        });
      } finally {
        runState.responder = null;
        runState.logCtx = null;
        runState.queue = null;
      }
    },

    abort(): void {
      session.abort();
    },

    async dispose(): Promise<void> {
      try {
        await mcpResult.dispose();
      } finally {
        await sessionManager.close();
      }
    },

    getCurrentStep(): { toolName?: string; label?: string } | undefined {
      const first = runState.pendingTools.values().next().value;
      if (!first) return undefined;
      return {
        toolName: first.toolName,
        label: (first.args as { label?: string })?.label,
      };
    },
  };
}

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
    platformToolPackFactories,
  } = options;
  const conversationId = office.address.conversationId;
  const conversationDir = office.dir;
  const workspaceDir = office.workspace.root;
  const agentConfig = resolveConversationSettings(office);

  const projection = resolveWorkspaceProjection(office);
  // Bootstrap validation fails runner creation early. resolveForRun repeats
  // the check against the actor-specific decision before any provider call.
  assertSandboxSupportsWorkspacePolicy(
    sandboxConfig,
    projection.doorPolicy,
    projection.promptSources.globalMemoryReadOnly === true,
  );
  const { executor, resolveForRun } = createRunnerExecutionContext(
    sandboxConfig,
    vaultManager,
    provisioner,
    office.workspace,
  );
  const pathContext = getUnresolvedSandboxPathContext(sandboxConfig, workspaceDir);

  const modelRegistry = options.models ?? MikanModels.create();
  if (modelRegistry.getError()) {
    log.logWarning("models.json load error", modelRegistry.getError()!);
  }
  const model = modelRegistry.resolve(agentConfig.provider, agentConfig.model);

  // Create tools (per-runner, with per-runner upload function setter)
  const toolBindings = createMikanTools(
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

  const systemPrompt = await buildInitialSystemPrompt({
    office,
    pathContext,
    projection,
    sandboxConfig,
  });
  const { contextFile, threadRootMessage } = sessionScope;
  const sessionManager = await openRunnerSessionManager({
    contextFile,
    runtimeWorkspaceRoot: pathContext.runtimeWorkspaceRoot,
    sessionKey,
    threadRootMessage,
  });
  const sessionUuid = extractSessionUuid(contextFile);
  const chatSessionManager = new ChatHistorySync();
  const { mcpResult, session } = await createRunnerAgentSession({
    workspaceDir,
    systemPrompt,
    model,
    agentConfig,
    tools: toolBindings.tools,
    sessionManager,
    modelRegistry,
    conversationId,
  });

  // Mutable per-run state - event handler references this
  const runState = createRunState();
  attachSessionEventHandlers({ session, runState, model, agentConfig });

  return createRunnerInterface({
    conversationId,
    conversationDir,
    sessionKey,
    office,
    sessionUuid,
    contextFile,
    sessionView,
    runState,
    executor,
    resolveForRun,
    session,
    model,
    agentConfig,
    sessionManager,
    chatSessionManager,
    mcpResult,
    toolBindings,
  });
}
