import type { Office, Workspace } from "../office/types.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { MikanModels } from "./models.js";
import { SessionStore } from "../sessions/session-store.js";
import {
  CONTROL_INPUT_CUSTOM_TYPE,
  RUN_CAUSE_CUSTOM_TYPE,
  type ThreadRootMessage,
} from "../sessions/types.js";
import { MikanAgentSession, DEFAULT_EVENT_BUDGET } from "./session.js";
import { runSubagent, DEFAULT_GLOBAL_SUBAGENT_SLOTS, SubagentSlotPool } from "./subagent.js";
import { loadSubagentProfiles } from "./subagent-profiles.js";
import { createMikanTools } from "./tools/index.js";
import { createSubagentTool } from "./tools/subagent.js";
import { createHistoryTool } from "./tools/history.js";
import { adaptAgentTool } from "./tools/pi-tools.js";
import { withSecretRedaction } from "./tools/secret-redaction.js";
import { createSandboxExecutionEnv } from "./execution-env.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
  PlatformName,
} from "../types.js";
import { ActorExecutionResolver } from "./execution-resolver.js";
import type { DockerContainerManager } from "../sandbox/provisioner.js";
import {
  warnUnenforcedPrivateOffice,
  createExecutor,
  getUnresolvedSandboxPathContext,
} from "../sandbox/registry.js";
import type { Executor, RuntimePathContext, SandboxConfig } from "../sandbox/types.js";
import type { VaultManager } from "../vault/types.js";
import { resolveWorkspaceProjection } from "../office/projection.js";
import type {
  RunnerExecutionContext,
  PlatformToolRoles,
  PreparedRunContext,
  RunPresentation,
  RunEventListener,
  RunnerSessionState,
  MikanToolContext,
} from "./types.js";
import type { CreateRunnerOptions, PiAgentWrapper } from "../types.js";
import { createHash } from "node:crypto";
import { loadSkillPatterns, resolveConversationSettings } from "../settings/index.js";
import { ensureDefaultOpenConnector } from "./open-connector.js";
import { OfficeEventStore } from "../events/index.js";
import { addLifecycleEvent, updateActiveSpanAttribution } from "../observability/index.js";
import type { ChatHistorySync } from "../sessions/chat-history-sync.js";
import { conversationIdOf, isThreadSessionKey } from "../sessions/session-key.js";
import type { PlatformToolPack } from "./tools/types.js";
import { START_TASK_TOOL, TASK_STATUS_TOOL } from "./tools/task.js";
import { loadMikanSkills } from "./skills.js";
import {
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
import { errorMessage } from "../unknown-values.js";

const globalSubagentSlots = new SubagentSlotPool(DEFAULT_GLOBAL_SUBAGENT_SLOTS);

async function createConfiguredAgentSession(params: {
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMikanTools>>["tools"];
  toolContext: MikanToolContext;
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
    async (request, hooks) =>
      runSubagent({
        request,
        onActivity: hooks?.onActivity,
        defaultModel: model,
        thinkingLevel,
        models,
        availableTools: tools.filter(
          (tool) => ![START_TASK_TOOL, TASK_STATUS_TOOL].includes(tool.name),
        ),
        profiles: runnableProfiles,
        slots: globalSubagentSlots,
        toolContext,
        parentEntries: await session!.sessionStore.getContextEntries(),
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
      return {
        pathContext: executor.getPathContext(workspace.root),
        projection: resolveWorkspaceProjection(office),
      };
    },
  };
}

const THREAD_SESSION_NAME_MAX_CHARS = 80;

function buildThreadSessionName(message: ThreadRootMessage | null): string | undefined {
  const firstLine = message?.text
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const chars = Array.from(firstLine);
  const title =
    chars.length > THREAD_SESSION_NAME_MAX_CHARS
      ? `${chars.slice(0, THREAD_SESSION_NAME_MAX_CHARS).join("")}…`
      : firstLine;
  const userLabel = message?.userName || message?.user || "unknown";
  return `[${userLabel}]: ${title}`;
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
    await ensureDefaultOpenConnector({
      office: options.office,
      platformWorkspaceId: options.platformWorkspaceId,
      defaultServer: options.openConnector,
      signal: options.signal,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    log.logWarning(
      `[${options.office.address.conversationId}] OpenConnector default provisioning failed`,
      errorMessage(error),
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
  bindTools: ReturnType<typeof createMikanTools>["bindRun"];
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
  const memory = getMemory(projection);
  const conversationSkillLoad = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
    loadSkillPatterns(office),
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

async function prepareRunContext(params: PrepareRunParams): Promise<PreparedRunContext> {
  const { message, platform, office, executor } = params;
  const sessionConversation = conversationIdOf(message.sessionKey);
  await mkdir(join(office.dir, "scratch"), { recursive: true });
  const { pathContext, memory, systemPrompt, triggerAttribution } =
    await preparePromptContext(params);
  params.bindTools({
    message,
    responder: params.responder,
    platformName: platform.name,
    runtimeWorkspaceRoot: pathContext.runtimeWorkspaceRoot,
  });

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
  const turnInstructions = buildTurnInstructions(message.id.startsWith("event:"));
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
  const memory = getMemory(projection);
  const { skills, skippedSkillLinks } = loadMikanSkills(
    office,
    pathContext.runtimeWorkspaceRoot,
    projection,
    loadSkillPatterns(office),
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
  office: Office;
  sessionKey: string;
  threadRootMessage: ThreadRootMessage | null;
}) {
  const { office, sessionKey, threadRootMessage } = params;
  const sessionManager = await SessionStore.open(office, sessionKey);
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
  toolContext: MikanToolContext;
  sessionManager: SessionStore;
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
  office: Office;
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
    office,
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
  await session.sessionStore.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: message.id });
  await session.prompt(prepared.userMessage, {
    allowTaskHandoff: responder.startTask !== undefined,
    allowTaskStatus: responder.getTaskStatus !== undefined,
    images: prepared.imageAttachments.length > 0 ? prepared.imageAttachments : undefined,
    budget: isEventRun ? DEFAULT_EVENT_BUDGET : undefined,
  });
  await presentation.wait();
  if (session.getLastRunStats().status === "aborted") runState.stopReason = "aborted";

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
              office,
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
  sessionKey: string;
  office: Office;
  sessionUuid: string;
  sessionView: CreateRunnerOptions["sessionView"];
  runEvents: CreateRunnerOptions["runEvents"];
  runState: RunnerSessionState;
  executor: Executor;
  resolveForRun: RunnerExecutionContext["resolveForRun"];
  session: MikanAgentSession;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionManager: SessionStore;
  chatSessionManager: ChatHistorySync;
  toolBindings: MikanToolBindings;
}

async function steerRun(
  session: MikanAgentSession,
  activeMessage: ConversationMessage | undefined,
  message: ConversationMessage,
): Promise<boolean> {
  if (!activeMessage) return false;
  await session.sessionStore.appendCustomEntry(CONTROL_INPUT_CUSTOM_TYPE, {
    messageId: message.id,
  });
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

async function publishRunLifecycle<T>(
  publish: RunEventListener | undefined,
  message: ConversationMessage,
  run: () => Promise<T>,
): Promise<T> {
  publish?.({
    type: "run_started",
    userName: message.userName ?? message.userId,
    text: message.text,
  });
  try {
    return await run();
  } finally {
    publish?.({ type: "run_ended" });
  }
}

function prepareRunnerTurn(
  params: RunnerInterfaceParams,
  message: ConversationMessage,
  responder: ConversationResponder,
  platform: MessagingInfo,
): ReturnType<typeof prepareRunContext> {
  const { office, executor, resolveForRun, session, toolBindings } = params;
  return prepareRunContext({
    message,
    responder,
    platform,
    office,
    executor,
    resolveForRun,
    session,
    bindTools: toolBindings.bindRun,
  });
}

function createRunnerInterface(params: RunnerInterfaceParams): PiAgentWrapper {
  const {
    conversationId,
    sessionKey,
    office,
    sessionUuid,
    sessionView,
    runEvents,
    runState,
    session,
    model,
    agentConfig,
    sessionManager,
    chatSessionManager,
  } = params;
  const publishRunEvent: RunEventListener | undefined = runEvents
    ? (event) => runEvents.publish(office.address, sessionKey, event)
    : undefined;
  let activeMessage: ConversationMessage | undefined;
  let stopped = false;
  return {
    steer: (message) => steerRun(session, activeMessage, message),
    async syncChatHistory(currentMessageId?: string): Promise<void> {
      await chatSessionManager.syncSessionManager({
        office,
        sessionKey,
        sessionManager,
        currentMessageId,
      });
    },

    async run(message, responder, platform) {
      activeMessage = message;
      stopped = false;
      let presentation: RunPresentation | undefined;
      return publishRunLifecycle(publishRunEvent, message, async () => {
        try {
          const prepared = await prepareRunnerTurn(params, message, responder, platform);
          if (stopped) return { stopReason: "aborted" };
          presentation = activateRunPresentation(runState, {
            responder,
            sessionConversation: prepared.sessionConversation,
            userName: message.userName,
            sessionUuid,
            triggerAttribution: prepared.triggerAttribution,
            publishRunEvent,
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
            office,
            sessionView,
          });
        } finally {
          activeMessage = undefined;
          presentation?.dispose();
        }
      });
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
  workspaceDir: string;
  executor: Executor;
  resolveForRun: RunnerExecutionContext["resolveForRun"];
  model: Model<Api>;
  modelRegistry: MikanModels;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  systemPrompt: string;
  sessionManager: SessionStore;
  toolBindings: MikanToolBindings;
  platformToolRoles: PlatformToolRoles;
  toolContext: MikanToolContext;
}): Promise<PiAgentWrapper> {
  const {
    options,
    conversationId,
    workspaceDir,
    executor,
    resolveForRun,
    model,
    modelRegistry,
    agentConfig,
    systemPrompt,
    sessionManager,
    toolBindings,
    platformToolRoles,
    toolContext,
  } = params;
  const { sessionKey, office, sessionView, chatHistory, runEvents } = options;
  try {
    const sessionUuid = sessionManager.getSessionId();
    const session = await createRunnerAgentSession({
      workspaceDir,
      systemPrompt,
      model,
      agentConfig,
      tools: [
        ...toolBindings.tools,
        withSecretRedaction(adaptAgentTool(createHistoryTool({ office, sessionKey }))),
      ],
      toolContext,
      sessionManager,
      modelRegistry,
      conversationId,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();

    const runState = createRunState();
    attachSessionEventHandlers({ session, runState, model, agentConfig, platformToolRoles });

    return createRunnerInterface({
      conversationId,
      sessionKey,
      office,
      sessionUuid,
      sessionView,
      runEvents,
      runState,
      executor,
      resolveForRun,
      session,
      model,
      agentConfig,
      sessionManager,
      chatSessionManager: chatHistory,
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
  warnUnenforcedPrivateOffice(sandboxConfig, projection.visibility, office.key);
  const { executor, resolveForRun } = createRunnerExecutionContext(
    sandboxConfig,
    vaultManager,
    provisioner,
    office.workspace,
  );
  const pathContext = getUnresolvedSandboxPathContext(sandboxConfig, workspaceDir);
  const toolContext: MikanToolContext = {
    env: createSandboxExecutionEnv(executor, sandboxConfig.type, pathContext.runtimeWorkspaceRoot),
  };

  const modelRegistry = options.models;
  if (modelRegistry.getError()) {
    log.logWarning("models.json load error", modelRegistry.getError()!);
  }
  const model = modelRegistry.resolve(agentConfig.provider, agentConfig.model);

  const platformToolPacks = (platformToolPackFactories ?? []).map((createPack) => createPack());
  const toolBindings = createMikanTools(
    executor,
    new OfficeEventStore(office, options.eventScheduler),
    { sandbox: sandboxConfig, resourceController: resourceController ?? provisioner },
    platformToolPacks,
    {
      model,
      getApiKey: () => modelRegistry.getApiKeyForProvider(model.provider),
      outputDir: office.dir,
    },
  );

  const systemPrompt = await buildInitialSystemPrompt({
    office,
    pathContext,
    projection,
    sandboxConfig,
  });
  options.signal?.throwIfAborted();
  const { threadRootMessage } = sessionScope;
  const sessionManager = await openRunnerSessionManager({
    office,
    sessionKey,
    threadRootMessage,
  });
  return finishRunnerCreation({
    options,
    conversationId,
    workspaceDir,
    executor,
    resolveForRun,
    model,
    modelRegistry,
    agentConfig,
    systemPrompt,
    sessionManager,
    toolBindings,
    platformToolRoles: collectPlatformToolRoles(platformToolPacks),
    toolContext,
  });
}

function collectPlatformToolRoles(packs: readonly PlatformToolPack[]): PlatformToolRoles {
  return {
    platformTools: new Set(packs.flatMap((pack) => pack.tools.map((tool) => tool.name))),
    finalResponseTools: new Set(packs.flatMap((pack) => pack.finalResponseTools ?? [])),
  };
}
