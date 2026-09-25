import type { Office, Workspace } from "../office/index.js";
import type { ExecutionToolContext, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MikanModels } from "./models.js";
import type { SessionStore } from "../sessions/session-store.js";
import { MikanAgentSession, DEFAULT_EVENT_BUDGET } from "./session.js";
import { runSubagent, DEFAULT_GLOBAL_SUBAGENT_SLOTS, SubagentSlotPool } from "./subagent.js";
import { loadSubagentProfiles } from "./subagent-profiles.js";
import { createMikanTools, createSubagentTool } from "./tools/index.js";
import { adaptAgentTool } from "./tools/pi-tools.js";
import { withSecretRedaction } from "./tools/secret-redaction.js";
import { createSandboxExecutionEnv } from "./execution-env.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConversationMessage,
  ConversationKind,
  ConversationResponder,
  MessagingInfo,
  PlatformName,
} from "../types.js";
import { ActorExecutionResolver } from "./execution-resolver.js";
import type { DockerContainerManager } from "../sandbox/provisioner.js";
import {
  assertSandboxSupportsWorkspacePolicy,
  createExecutor,
  type Executor,
  type RuntimePathContext,
  type SandboxConfig,
  getUnresolvedSandboxPathContext,
} from "../sandbox/index.js";
import type { VaultManager } from "../vault/index.js";
import { resolveWorkspaceProjection } from "../office/projection.js";
import type {
  RunnerExecutionContext,
  PreparedRunContext,
  RunPresentation,
  RunnerSessionState,
} from "./types.js";
import type { CreateRunnerOptions, OfficeAddress, PiAgentWrapper } from "../types.js";
import { createHash } from "node:crypto";
import { resolveConversationSettings } from "../settings/index.js";
import { ensureDefaultOpenConnector } from "./open-connector.js";
import { OfficeEventStore } from "../events/index.js";
import { addLifecycleEvent, updateActiveSpanAttribution } from "../observability/index.js";
import { ChatHistorySync } from "../sessions/chat-history-sync.js";
import { conversationIdOf, isThreadSessionKey } from "../sessions/session-key.js";
import {
  extractSessionUuid,
  openManagedSession,
  type ThreadRootMessage,
} from "../sessions/store.js";
import type { PlatformToolRunContext } from "./tools/types.js";
import { loadMikanSkills } from "./skills.js";
import {
  normalizeAttachRuntimePath,
  withStagedRuntimeFile,
  buildPromptPayload,
  buildSystemPrompt,
  buildTurnInstructions,
  getMemory,
  resolveTriggerAttribution,
} from "./prompt.js";
import {
  attachSessionEventHandlers,
  activateRunPresentation,
  createRunState,
  finalizeRunResponse,
  getFinalAssistantText,
  isEventTriggerAttribution,
  reportUsageSummary,
} from "./presenter.js";

import * as log from "../log.js";

const globalSubagentSlots = new SubagentSlotPool(DEFAULT_GLOBAL_SUBAGENT_SLOTS);

async function createConfiguredAgentSession(params: {
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMikanTools>>["tools"];
  toolContext: ExecutionToolContext;
  sessionStore: SessionStore;
  models: MikanModels;
}): Promise<MikanAgentSession> {
  const {
    workspaceDir,
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    toolContext,
    sessionStore,
    models,
  } = params;
  const loadedProfiles = loadSubagentProfiles(workspaceDir);
  for (const diagnostic of loadedProfiles.diagnostics) {
    log.logWarning(`Subagent profile ignored: ${diagnostic.path}`, diagnostic.message);
  }

  const availableToolNames = new Set(tools.map((tool) => tool.name));
  const runnableProfiles = new Map(
    [...loadedProfiles.profiles].filter(([, profile]) =>
      profile.tools.every((tool) => availableToolNames.has(tool)),
    ),
  );
  let session: MikanAgentSession | undefined;
  const subagentTool = createSubagentTool(
    (request, hooks) =>
      runSubagent({
        request,
        ...(hooks?.onActivity ? { onActivity: hooks.onActivity } : {}),
        defaultModel: model,
        thinkingLevel,
        models,
        workspaceDir,
        availableTools: tools.filter((tool) => !["start_task", "task_status"].includes(tool.name)),
        profiles: runnableProfiles,
        slots: globalSubagentSlots,
        toolContext,
        parentMessages: [...session!.messages],
        onUsage: session!.captureExternalUsageSink(),
      }),
    runnableProfiles,
  );

  session = new MikanAgentSession({
    systemPrompt,
    model,
    thinkingLevel,
    tools: [...tools, adaptAgentTool(subagentTool)],
    toolContext,
    models,
    sessionStore,
  });
  const reloaded = await session.reloadFromSession();
  if (reloaded > 0) log.logInfo(`Reloaded ${reloaded} messages from session context`);
  return session;
}

function createRunnerExecutionContext(
  sandboxConfig: SandboxConfig,
  vaultManager: VaultManager | undefined,
  provisioner: DockerContainerManager | undefined,
  workspace: Workspace,
): RunnerExecutionContext {
  const executionResolver =
    vaultManager && sandboxConfig.type !== "host"
      ? new ActorExecutionResolver(sandboxConfig, vaultManager, provisioner, workspace)
      : undefined;

  let activeExecutor: Executor =
    executionResolver !== undefined
      ? createExecutor({ type: "host" })
      : createExecutor(sandboxConfig);
  const executor: Executor = {
    exec(command, options) {
      return activeExecutor.exec(command, options);
    },
    readFile(path, options) {
      return activeExecutor.readFile(path, options);
    },
    readFileBase64(path, options) {
      return activeExecutor.readFileBase64(path, options);
    },
    writeFile(path, content, options) {
      return activeExecutor.writeFile(path, content, options);
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
    executor,
    async resolveForRun(context) {
      if (executionResolver) {
        const decision = await executionResolver.resolve(context);
        activeExecutor = decision.executor;
        return {
          pathContext: decision.pathContext,
          projection: decision.projection,
        };
      }

      const office = workspace.office(context.address);
      const projection = resolveWorkspaceProjection(office);
      assertSandboxSupportsWorkspacePolicy(sandboxConfig, projection.visibility, office.key);
      return {
        pathContext: executor.getPathContext(workspace.root),
        projection,
      };
    },
  };
}

function buildThreadSessionName(message: ThreadRootMessage | null): string | undefined {
  const text = message?.text?.trim();
  if (!text) return undefined;
  const userLabel = message?.userName || message?.user || "unknown";
  return `[${userLabel}]: ${text}`;
}

async function ensureDefaultMcpServers(options: {
  office: Office;
  trustModel: CreateRunnerOptions["trustModel"];
  platformWorkspaceId?: string;
  openConnector?: CreateRunnerOptions["openConnector"];
  signal?: AbortSignal;
}): Promise<void> {
  if (options.trustModel === "open-trigger") return;
  try {
    await ensureDefaultOpenConnector(
      options.office,
      options.platformWorkspaceId,
      options.openConnector,
      options.signal,
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    log.logWarning(
      `[${options.office.address.conversationId}] OpenConnector default provisioning failed`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

interface PrepareRunParams {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
  office: Office;
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
  bindTasks: ReturnType<typeof createMikanTools>["bindTasks"];
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  bindPlatformToolPacks: (ctx: PlatformToolRunContext) => void;
}

interface RunPromptContext {
  pathContext: RuntimePathContext;
  memory: string;
  systemPrompt: string;
  triggerAttribution: string | undefined;
}

async function preparePromptContext(params: PrepareRunParams): Promise<RunPromptContext> {
  const { message, platform, office, executor, resolveForRun, session } = params;
  const conversationId = office.address.conversationId;
  const decision = await resolveForRun({
    address: message.address,
    userId: message.userId,
    trustModel: platform.trustModel,
  });
  const { pathContext, projection } = decision;
  const reloaded = await session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from context`);
  }

  const memory = await getMemory(projection);
  const conversationSkillLoad = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
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
  session.setSystemPrompt(systemPrompt);
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
    bindTasks,
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
  setImageUploadFunction(async (hostPath: string, title?: string) => {
    await responder.uploadFile(hostPath, title);
  });
  bindTasks(responder);
  setReactFunction(responder.react ? async (emoji: string) => responder.react!(emoji) : null);
  bindPlatformToolPacks({
    conversationId: office.address.conversationId,
    platformName: platform.name,
    threadTs: message.threadTs,
  });
}

async function prepareRunContext(params: PrepareRunParams): Promise<PreparedRunContext> {
  const { message, platform, office, executor } = params;
  const sessionConversation = conversationIdOf(message.sessionKey);
  await mkdir(join(office.dir, "scratch"), { recursive: true });
  const { pathContext, memory, systemPrompt, triggerAttribution } =
    await preparePromptContext(params);
  bindRunCapabilities(params, pathContext);

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

async function rollbackRunnerResource(label: string, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    log.logWarning(`Runner rollback failed to ${label}`, String(error));
  }
}

async function openRunnerSessionManager(params: {
  contextFile: string;
  runtimeWorkspaceRoot: string;
  sessionKey: string;
  threadRootMessage: ThreadRootMessage | null;
}) {
  const { contextFile, runtimeWorkspaceRoot, sessionKey, threadRootMessage } = params;
  const sessionManager = await openManagedSession(contextFile, runtimeWorkspaceRoot);
  try {
    const threadSessionName = buildThreadSessionName(threadRootMessage);
    if (
      isThreadSessionKey(sessionKey) &&
      threadSessionName &&
      (await sessionManager.getSessionName()) !== threadSessionName
    ) {
      await sessionManager.setSessionName(threadSessionName);
    }
    return sessionManager;
  } catch (error) {
    await rollbackRunnerResource("close the session writer", () => sessionManager.close());
    throw error;
  }
}

async function createRunnerAgentSession(params: {
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  tools: ReturnType<typeof createMikanTools>["tools"];
  toolContext: ExecutionToolContext;
  sessionManager: Awaited<ReturnType<typeof openManagedSession>>;
  modelRegistry: MikanModels;
  conversationId: string;
  signal?: AbortSignal;
}) {
  const {
    workspaceDir,
    systemPrompt,
    model,
    agentConfig,
    tools,
    toolContext,
    sessionManager,
    modelRegistry,
    signal,
  } = params;
  const mcpTools = await sessionManager.connectMcp(agentConfig.mcpServers ?? {}, signal);
  return createConfiguredAgentSession({
    workspaceDir,
    systemPrompt,
    model,
    thinkingLevel: agentConfig.thinkingLevel,
    tools: [...tools, ...mcpTools.map(withSecretRedaction)],
    toolContext,
    sessionStore: sessionManager,
    models: modelRegistry,
  });
}

interface PreparedTurnParams {
  prepared: PreparedRunContext;
  presentation: RunPresentation;
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
}

async function runPreparedTurn(params: PreparedTurnParams): Promise<{
  stopReason: string;
  errorMessage?: string;
  finalText: string;
}> {
  const {
    prepared,
    presentation,
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
    model: model.id,
    channel_id: prepared.sessionConversation,
    session_id: sessionUuid,
    "mikan.input.message_count": 1,
    "mikan.input.characters": prepared.userMessage.length,
    "mikan.input.attachment_count": message.attachments?.length ?? 0,
    "mikan.input.image_count": prepared.imageAttachments.length,
    "mikan.input.has_text": prepared.userMessage.length > 0,
  });
  addLifecycleEvent("agent.prompt.sent", {
    provider: model.provider,
    model: agentConfig.model,
    channel_id: prepared.sessionConversation,
    session_id: sessionUuid,
    attachment_count: message.attachments?.length ?? 0,
    image_attachment_count: prepared.imageAttachments.length,
  });

  const isEventRun = message.id.startsWith("event:");
  await session.prompt(prepared.userMessage, {
    allowTaskHandoff: responder.startTask !== undefined,
    allowTaskStatus: responder.getTaskStatus !== undefined,
    ...(prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : {}),
    ...(isEventRun ? { budget: DEFAULT_EVENT_BUDGET } : {}),
  });
  await presentation.wait();

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
    initialTask: message.id.startsWith("task:"),
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
    waitForQueue: presentation.wait,
  });
  return {
    stopReason: runState.stopReason,
    errorMessage: runState.errorMessage,
    finalText: getFinalAssistantText(session),
  };
}

type MikanToolBindings = ReturnType<typeof createMikanTools>;

interface RunnerInterfaceParams {
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
  toolBindings: MikanToolBindings;
}

async function steerRun(
  session: MikanAgentSession,
  activeMessage: ConversationMessage | undefined,
  message: ConversationMessage,
): Promise<boolean> {
  if (!activeMessage) return false;
  await session.sessionStore.appendCustomEntry("mikan.control_input", { messageId: message.id });
  if (!session.isActiveRun)
    throw new Error("Task is preparing or settling. Please retry this update shortly.");
  if (message.userId !== activeMessage.userId)
    throw new Error("Only the task's current actor can guide this run.");
  if (message.attachments?.length)
    throw new Error("Stop the task before continuing with new attachments.");
  if (!(await session.steer(`[${message.userName ?? message.userId}]: ${message.text}`))) {
    throw new Error("Task settled while receiving this update. Please send it again to continue.");
  }
  return true;
}

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
    toolBindings,
  } = params;
  let activeMessage: ConversationMessage | undefined;
  let stopped = false;
  return {
    steer: (message) => steerRun(session, activeMessage, message),
    async syncChatHistory(currentMessageId?: string): Promise<void> {
      await chatSessionManager.syncSessionManager({
        conversationDir,
        sessionKey,
        sessionManager,
        currentMessageId,
      });
    },

    async run(message, responder, platform) {
      activeMessage = message;
      stopped = false;
      let presentation: RunPresentation | undefined;
      try {
        const prepared = await prepareRunContext({
          message,
          responder,
          platform,
          office,
          executor,
          resolveForRun,
          session,
          setEventContext: toolBindings.setEventContext,
          setSandboxContext: toolBindings.setSandboxContext,
          setUploadFunction: toolBindings.setUploadFunction,
          setImageUploadFunction: toolBindings.setImageUploadFunction,
          setReactFunction: toolBindings.setReactFunction,
          bindTasks: toolBindings.bindTasks,
          bindPlatformToolPacks: toolBindings.bindPlatformToolPacks,
        });
        if (stopped) return { stopReason: "aborted" };
        presentation = activateRunPresentation(runState, {
          responder,
          sessionConversation: prepared.sessionConversation,
          userName: message.userName,
          sessionUuid,
          triggerAttribution: prepared.triggerAttribution,
        });
        return await runPreparedTurn({
          prepared,
          presentation,
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
        activeMessage = undefined;
        presentation?.dispose();
      }
    },

    abort(): void {
      stopped = true;
      session.abort();
    },

    async dispose(): Promise<void> {
      await sessionManager.close();
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

async function finishRunnerCreation(params: {
  options: CreateRunnerOptions;
  conversationId: string;
  conversationDir: string;
  workspaceDir: string;
  executor: Executor;
  resolveForRun: RunnerExecutionContext["resolveForRun"];
  model: Model<Api>;
  modelRegistry: MikanModels;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  systemPrompt: string;
  sessionManager: Awaited<ReturnType<typeof openManagedSession>>;
  toolBindings: MikanToolBindings;
  toolContext: ExecutionToolContext;
}): Promise<PiAgentWrapper> {
  const {
    options,
    conversationId,
    conversationDir,
    workspaceDir,
    executor,
    resolveForRun,
    model,
    modelRegistry,
    agentConfig,
    systemPrompt,
    sessionManager,
    toolBindings,
    toolContext,
  } = params;
  const { sessionKey, office, sessionScope, sessionView } = options;
  const { contextFile } = sessionScope;
  try {
    const sessionUuid = extractSessionUuid(contextFile);
    const chatSessionManager = new ChatHistorySync();
    const session = await createRunnerAgentSession({
      workspaceDir,
      systemPrompt,
      model,
      agentConfig,
      tools: toolBindings.tools,
      toolContext,
      sessionManager,
      modelRegistry,
      conversationId,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();

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
      toolBindings,
    });
  } catch (error) {
    await rollbackRunnerResource("close the session writer", () => sessionManager.close());
    throw error;
  }
}

export async function createRunner(options: CreateRunnerOptions): Promise<PiAgentWrapper> {
  options.signal?.throwIfAborted();
  const {
    sandboxConfig,
    sessionKey,
    office,
    trustModel,
    sessionScope,
    vaultManager,
    provisioner,
    resourceController,
    platformToolPackFactories,
  } = options;
  const conversationId = office.address.conversationId;
  const conversationDir = office.dir;
  const workspaceDir = office.workspace.root;
  await ensureDefaultMcpServers({
    office,
    trustModel,
    platformWorkspaceId: options.platformWorkspaceId,
    openConnector: options.openConnector,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const resolvedAgentConfig = resolveConversationSettings(office);
  const agentConfig = {
    ...resolvedAgentConfig,
    mcpServers: trustModel === "open-trigger" ? {} : (resolvedAgentConfig.mcpServers ?? {}),
  };

  const projection = resolveWorkspaceProjection(office);
  assertSandboxSupportsWorkspacePolicy(sandboxConfig, projection.visibility, office.key);
  const { executor, resolveForRun } = createRunnerExecutionContext(
    sandboxConfig,
    vaultManager,
    provisioner,
    office.workspace,
  );
  const pathContext = getUnresolvedSandboxPathContext(sandboxConfig, workspaceDir);
  const toolContext: ExecutionToolContext = {
    env: createSandboxExecutionEnv(executor, sandboxConfig.type, pathContext.runtimeWorkspaceRoot),
  };

  const modelRegistry = options.models ?? MikanModels.create();
  if (modelRegistry.getError()) {
    log.logWarning("models.json load error", modelRegistry.getError()!);
  }
  const model = modelRegistry.resolve(agentConfig.provider, agentConfig.model);

  const toolBindings = createMikanTools(
    executor,
    new OfficeEventStore(office, options.eventScheduler),
    { sandbox: sandboxConfig, resourceController: resourceController ?? provisioner },
    platformToolPackFactories ?? [],
    {
      model,
      getApiKey: () => modelRegistry.getApiKeyForProvider(model.provider),
      outputDir: conversationDir,
    },
  );

  const systemPrompt = await buildInitialSystemPrompt({
    office,
    pathContext,
    projection,
    sandboxConfig,
  });
  options.signal?.throwIfAborted();
  const { contextFile, threadRootMessage } = sessionScope;
  const sessionManager = await openRunnerSessionManager({
    contextFile,
    runtimeWorkspaceRoot: pathContext.runtimeWorkspaceRoot,
    sessionKey,
    threadRootMessage,
  });
  return finishRunnerCreation({
    options,
    conversationId,
    conversationDir,
    workspaceDir,
    executor,
    resolveForRun,
    model,
    modelRegistry,
    agentConfig,
    systemPrompt,
    sessionManager,
    toolBindings,
    toolContext,
  });
}
