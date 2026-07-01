import { Agent, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { AgentSessionRuntime } from "./harness/agent-session-runtime.js";
import { createMikanAgent, createMikanSessionServices } from "./harness/agent-session-services.js";
import { AgentSession } from "./harness/agent-session.js";
import { DEFAULT_RETRY_SETTINGS } from "./harness/retry-policy.js";
import { SessionManager } from "./harness/session-manager.js";
import { buildSystemPrompt } from "./harness/system-prompt.js";
import { MikanResourceLoader } from "./harness/resource-loader.js";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join, posix } from "path";
import type {
  ConversationMessage,
  ConversationResponder,
  ConversationKind,
  MessagingInfo,
  PlatformName,
} from "./adapter.js";
import type { AgentEventPayload } from "./types.js";
import type { SessionViewTokenStoreLike } from "./commands/types.js";
import { resolveConversationSettings } from "./config.js";
import { ActorExecutionResolver } from "./execution-resolver.js";
import * as log from "./log.js";
import { reportUserFacingError } from "./observability/sentry.js";
import type { DockerContainerManager } from "./provisioner.js";
import {
  createExecutor,
  type Executor,
  type RuntimePathContext,
  type SandboxConfig,
} from "./sandbox/index.js";
import { createMountedRuntimePathContext } from "./sandbox/path-context.js";
import {
  addLifecycleBreadcrumb,
  metricAttributes,
  updateActiveSpanAttribution,
} from "./observability/sentry.js";
import type { VaultManager } from "./vault/index.js";
import { AgentMemoryFileManager } from "./sessions/agent-memory-file-manager.js";
import { type ResolvedSessionScope } from "./sessions/store.js";
import { createMikanTools } from "./tools/index.js";
import * as Sentry from "@sentry/node";
import { formatLocalTimestamp } from "./utils/date.js";
import { resolveConfiguredModel } from "./model-registry.js";
import { emitAgentEvent } from "./agent-events.js";

export type { PiAgentWrapper } from "./types.js";
import type { PiAgentWrapper } from "./types.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
  return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

export function resolveTriggerAttribution(
  message: Pick<ConversationMessage, "id" | "text" | "userName">,
): string | undefined {
  const eventTextMatch = message.text.match(/^\[EVENT:([^:]+):/);
  if (eventTextMatch) return `[event: ${eventTextMatch[1]}]`;
  const eventIdMatch = message.id.match(/^event:([^:]+)/);
  if (eventIdMatch) return `[event: ${eventIdMatch[1]}]`;
  if (message.userName) return `@${message.userName}`;
  return undefined;
}

export function getUnresolvedSandboxPathContext(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  if (sandboxConfig.type === "image") {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  return createExecutor(sandboxConfig).getPathContext(hostWorkspaceRoot);
}

interface RunnerExecutionContext {
  executionResolver?: ActorExecutionResolver;
  executor: Executor;
  getPathContext: () => RuntimePathContext;
  resolveExecutorForRun(context: {
    platform: string;
    userId: string;
    conversationId: string;
  }): Promise<void>;
}

interface RunnerSessionState {
  responder: ConversationResponder | null;
  logCtx: {
    conversationId: string;
    userName?: string;
    conversationName?: string;
    sessionId?: string;
  } | null;
  queue: {
    enqueue(fn: () => Promise<void>, errorContext: string): void;
  } | null;
  pendingTools: Map<string, { toolName: string; args: unknown; startTime: number }>;
  toolProgress: Map<string, { label: string; status: "running" | "done" | "error" }>;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  llmCallCount: number;
  stopReason: string;
  errorMessage: string | undefined;
  reportedLlmError: boolean;
  finalResponseHandledByTool: boolean;
  triggerAttribution?: string;
}

interface PreparedRunContext {
  sessionConversation: string;
  runQueue: ReturnType<typeof createRunQueue>;
  userMessage: string;
  imageAttachments: ImageContent[];
  triggerAttribution?: string;
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

function createEmptyUsageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createRunState(): RunnerSessionState {
  return {
    responder: null,
    logCtx: null,
    queue: null,
    pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
    toolProgress: new Map<string, { label: string; status: "running" | "done" | "error" }>(),
    totalUsage: createEmptyUsageTotals(),
    llmCallCount: 0,
    stopReason: "stop",
    errorMessage: undefined,
    reportedLlmError: false,
    finalResponseHandledByTool: false,
    triggerAttribution: undefined,
  };
}

function resetRunState(
  runState: RunnerSessionState,
  responder: ConversationResponder,
  sessionConversation: string,
  userName: string | undefined,
  sessionUuid: string,
  triggerAttribution: string | undefined,
): void {
  runState.responder = responder;
  runState.logCtx = {
    conversationId: sessionConversation,
    userName,
    conversationName: undefined,
    sessionId: sessionUuid,
  };
  runState.pendingTools.clear();
  runState.toolProgress.clear();
  runState.totalUsage = createEmptyUsageTotals();
  runState.llmCallCount = 0;
  runState.stopReason = "stop";
  runState.errorMessage = undefined;
  runState.reportedLlmError = false;
  runState.finalResponseHandledByTool = false;
  runState.triggerAttribution = triggerAttribution;
}

function createRunQueue(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): {
  queue: { enqueue(fn: () => Promise<void>, errorContext: string): void };
  wait: () => Promise<void>;
} {
  let queueChain = Promise.resolve();
  return {
    queue: {
      enqueue(fn: () => Promise<void>, errorContext: string): void {
        queueChain = queueChain.then(async () => {
          if (runState.finalResponseHandledByTool) return;
          try {
            await fn();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.logWarning(`API error (${errorContext})`, errMsg);
            try {
              await responder.respondDiagnostic(`Error: ${errMsg}`, { style: "error" });
            } catch {
              // Ignore
            }
          }
        });
      },
    },
    wait: () => queueChain,
  };
}

function formatTimestampedUserMessage(message: ConversationMessage): string {
  const timestamp = formatLocalTimestamp(new Date())!;
  const threadContext = message.threadTs ? ` [in-thread:${message.threadTs}]` : "";
  return `[${timestamp}] [${message.userName || "unknown"}]${threadContext}: ${message.text}`;
}

function collectMessageAttachments(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
): { imageAttachments: ImageContent[]; nonImagePaths: string[] } {
  const imageAttachments: ImageContent[] = [];
  const nonImagePaths: string[] = [];

  for (const attachment of message.attachments || []) {
    const runtimePath = `${workspacePath}/${attachment.localPath}`;
    const hostPath = pathContext?.runtimeToHostPath?.(runtimePath) ?? runtimePath;
    const mimeType = getImageMimeType(attachment.localPath);

    if (mimeType && existsSync(hostPath)) {
      try {
        imageAttachments.push({
          type: "image",
          mimeType,
          data: readFileSync(hostPath).toString("base64"),
        });
      } catch {
        nonImagePaths.push(runtimePath);
      }
    } else {
      nonImagePaths.push(runtimePath);
    }
  }

  return { imageAttachments, nonImagePaths };
}

export function buildPromptPayload(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
): {
  userMessage: string;
  imageAttachments: ImageContent[];
} {
  let userMessage = formatTimestampedUserMessage(message);
  const { imageAttachments, nonImagePaths } = collectMessageAttachments(
    message,
    workspacePath,
    pathContext,
  );

  if (nonImagePaths.length > 0) {
    userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
  }

  return { userMessage, imageAttachments };
}

async function writePromptDebugContext(
  conversationDir: string,
  systemPrompt: string,
  session: AgentSession,
  userMessage: string,
  imageAttachmentCount: number,
): Promise<void> {
  const debugContext = {
    systemPrompt,
    messages: session.messages,
    newUserMessage: userMessage,
    imageAttachmentCount,
  };
  await writeFile(
    join(conversationDir, "last_prompt.jsonl"),
    JSON.stringify(debugContext, null, 2),
  );
}

function getFinalAssistantText(session: AgentSession): string {
  const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
  return (
    lastAssistant?.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n") || ""
  );
}

export function appendTriggerAttribution(
  text: string,
  triggerAttribution: string | undefined,
  sessionLink?: string,
): string {
  if (!triggerAttribution) return text;
  const trimmed = text.trimEnd();
  const legacySuffix = `_Triggered by ${triggerAttribution}_`;
  const suffix = sessionLink
    ? `_Triggered by ${triggerAttribution} · session: ${sessionLink}_`
    : legacySuffix;
  if (trimmed.endsWith(suffix)) return text;
  const body = trimmed.endsWith(legacySuffix)
    ? trimmed.slice(0, -legacySuffix.length).trimEnd()
    : trimmed;
  return `${body}\n\n${suffix}`;
}

function isEventTriggerAttribution(triggerAttribution: string | undefined): boolean {
  return triggerAttribution?.startsWith("[event:") === true;
}

function extractToolLabel(toolName: string, args: unknown): string {
  const label = (args as { label?: unknown } | undefined)?.label;
  if (typeof label !== "string") return toolName;
  return label.trim() || toolName;
}

function formatToolProgress(runState: RunnerSessionState): string {
  const lines = Array.from(runState.toolProgress.values()).map((item) => {
    const marker = item.status === "running" ? "•" : item.status === "error" ? "✗" : "✓";
    return `${marker} ${item.label}`;
  });
  return lines.join("\n");
}

function formatResponseWithToolProgress(text: string, runState: RunnerSessionState): string {
  const progress = formatToolProgress(runState);
  return progress ? `${progress}\n\n${text}` : text;
}

async function replaceResponseWithToolProgress(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): Promise<void> {
  const progress = formatToolProgress(runState);
  if (progress) await responder.replaceResponse(progress);
}

async function finalizeRunResponse(
  responder: ConversationResponder,
  session: AgentSession,
  runState: RunnerSessionState,
  options?: {
    triggerAttribution?: string;
    triggerSessionLink?: string;
    createOverflowLink?: () => string;
    platform?: string;
    model?: Model<Api>;
    sessionConversation?: string;
    sessionUuid?: string;
  },
): Promise<void> {
  if (runState.stopReason === "error" && runState.errorMessage) {
    if (!runState.reportedLlmError) {
      runState.reportedLlmError = true;
      reportUserFacingError(new Error("LLM run completed with error stop reason"), {
        domain: "llm",
        surface: "assistant_response",
        operation: "llm_turn",
        severity: "error",
        platform: options?.platform,
        provider: options?.model?.provider,
        model: options?.model?.name,
        stopReason: runState.stopReason,
        context: {
          sessionConversation: options?.sessionConversation,
          sessionUuid: options?.sessionUuid,
          hasErrorMessage: true,
          llmCallCount: runState.llmCallCount,
        },
      });
    }
    try {
      await responder.replaceResponse("_Sorry, something went wrong_");
      await responder.respondDiagnostic(`Error: ${runState.errorMessage}`, {
        style: "error",
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.logWarning("Failed to post error message", errMsg);
      reportUserFacingError(err, {
        domain: "chat_platform",
        surface: "final_response",
        operation: "finalize_error_response",
        severity: "error",
        platform: options?.platform,
        context: {
          sessionConversation: options?.sessionConversation,
          sessionUuid: options?.sessionUuid,
          stopReason: runState.stopReason,
        },
      });
    }
    return;
  }

  const finalText = getFinalAssistantText(session);
  if (runState.finalResponseHandledByTool) {
    log.logInfo("Final response already handled by tool - skipping final replacement");
    return;
  }
  if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
    try {
      await responder.deleteResponse();
      log.logInfo("Silent response - deleted message and thread");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.logWarning("Failed to delete message for silent response", errMsg);
    }
    return;
  }

  if (!finalText.trim()) return;

  try {
    await responder.replaceResponse(
      appendTriggerAttribution(
        formatResponseWithToolProgress(finalText, runState),
        options?.triggerAttribution,
        options?.triggerSessionLink,
      ),
      { createOverflowLink: options?.createOverflowLink },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.logWarning("Failed to replace message with final text", errMsg);
    reportUserFacingError(err, {
      domain: "chat_platform",
      surface: "final_response",
      operation: "replace_final_response",
      severity: "error",
      platform: options?.platform,
      context: {
        sessionConversation: options?.sessionConversation,
        sessionUuid: options?.sessionUuid,
        finalTextLength: finalText.length,
      },
    });
  }
}

interface UsageReportContext {
  session: AgentSession;
  runState: RunnerSessionState;
  responder: ConversationResponder;
  platform: MessagingInfo;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionConversation: string;
  sessionUuid: string;
  waitForQueue: () => Promise<void>;
}

async function reportUsageSummary(ctx: UsageReportContext): Promise<void> {
  const {
    session,
    runState,
    responder,
    platform,
    model,
    agentConfig,
    sessionConversation,
    sessionUuid,
    waitForQueue,
  } = ctx;
  const lastAssistantMessage = session.messages
    .slice()
    .toReversed()
    .find(
      (message): message is Extract<typeof message, { role: "assistant" }> =>
        message.role === "assistant" && message.stopReason !== "aborted",
    );

  const contextTokens = lastAssistantMessage
    ? lastAssistantMessage.usage.input +
      lastAssistantMessage.usage.output +
      lastAssistantMessage.usage.cacheRead +
      lastAssistantMessage.usage.cacheWrite
    : 0;
  const contextWindow = model.contextWindow || 200000;

  const { totalUsage } = runState;
  const runMetricAttributes = metricAttributes({
    provider: model.provider,
    model: agentConfig.model,
    channel_id: sessionConversation,
    session_id: sessionUuid,
    stop_reason: runState.stopReason,
    llm_calls: runState.llmCallCount,
  });
  Sentry.metrics.distribution("agent.run.tokens_in", totalUsage.input, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.tokens_out", totalUsage.output, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.cache_read", totalUsage.cacheRead, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.cache_write", totalUsage.cacheWrite, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.cost", totalUsage.cost.total, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.gauge("agent.context.utilization", contextTokens / contextWindow, {
    unit: "ratio",
    attributes: runMetricAttributes,
  });

  const summary = log.logUsageSummary(
    runState.logCtx!,
    runState.totalUsage,
    contextTokens,
    contextWindow,
  );
  if (platform.diagnostics?.showUsageSummary === true) {
    runState.queue!.enqueue(
      () => responder.respondDiagnostic(summary, { style: "muted" }),
      "usage summary",
    );
    await waitForQueue();
  }
}

function reloadSessionMessages(
  sessionManager: SessionManager,
  conversationId: string,
  agent: Agent,
): void {
  const messages = sessionManager.buildSessionContext().messages;
  if (messages.length > 0) {
    agent.state.messages = messages;
    log.logInfo(`[${conversationId}] Reloaded ${messages.length} messages from context`);
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
  sessionManager: SessionManager;
  session: AgentSession;
  agent: Agent;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: ConversationKind;
    userId: string;
  }) => void;
  setSandboxContext: (context: { conversationId: string; userId: string }) => void;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  pathContext: RuntimePathContext;
  resourceLoader: MikanResourceLoader;
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
    sessionManager,
    session,
    agent,
    setEventContext,
    setSandboxContext,
    setUploadFunction,
    resourceLoader,
  } = params;
  let pathContext = params.pathContext;
  const sessionConversation = message.sessionKey.split(":")[0];

  await mkdir(join(conversationDir, "scratch"), { recursive: true });

  if (executionResolver) {
    await resolveExecutorForRun({
      platform: platform.name,
      userId: message.userId,
      conversationId,
    });
    pathContext = getPathContext();
  }

  reloadSessionMessages(sessionManager, conversationId, agent);

  const loaded = resourceLoader.reloadMemory();
  const memory = loaded.memory;
  const skills = loaded.skills;
  const triggerAttribution = resolveTriggerAttribution(message);
  const systemPrompt = buildSystemPrompt({
    workspacePath: pathContext.runtimeWorkspaceRoot,
    conversationId,
    conversationKind: message.conversationKind,
    currentUserId: message.userId,
    memory,
    sandboxConfig: executor.getSandboxConfig(),
    platform,
    skills,
    isEventTrigger: message.id.startsWith("event:"),
    triggerAttribution,
  });
  session.agent.state.systemPrompt = systemPrompt;

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
  await writePromptDebugContext(
    conversationDir,
    systemPrompt,
    session,
    userMessage,
    imageAttachments.length,
  );

  return {
    sessionConversation,
    runQueue,
    userMessage,
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
  session: AgentSession;
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
        const hasToolCall = assistantMsg.content.some((part: { type?: string }) =>
          ["tool_use", "toolCall", "tool-call"].includes(part.type ?? ""),
        );
        for (const part of assistantMsg.content as Array<{
          type?: string;
          thinking?: string;
          text?: string;
        }>) {
          if (part.type === "thinking" && part.thinking) {
            thinkingParts.push(part.thinking);
          } else if (part.type === "text" && part.text) {
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
  });
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const textParts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return JSON.stringify(result);
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
  const { tools, setUploadFunction, setEventContext, setSandboxContext } = createMikanTools(
    executor,
    workspaceDir,
    { sandbox: sandboxConfig, provisioner },
  );

  const services = createMikanSessionServices();
  const { modelRegistry } = services;
  for (const diagnostic of services.diagnostics) {
    log.logWarning(diagnostic.message);
  }
  const model = resolveConfiguredModel(modelRegistry, agentConfig.provider, agentConfig.model);

  // Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
  const resourceLoader = new MikanResourceLoader(
    conversationDir,
    pathContext.runtimeWorkspaceRoot,
    workspaceBase,
  );
  const loaded = resourceLoader.load();
  const memory = loaded.memory;
  const skills = loaded.skills;
  const emptyPlatform: MessagingInfo = {
    name: "chat",
    formattingGuide: "",
    channels: [],
    users: [],
  };
  const systemPrompt = buildSystemPrompt({
    workspacePath: pathContext.runtimeWorkspaceRoot,
    conversationId,
    conversationKind: "shared",
    memory,
    sandboxConfig,
    platform: emptyPlatform,
    skills,
  });

  // Create session runtime
  const { contextFile } = sessionScope;
  const sessionRuntime = new AgentSessionRuntime(
    sessionKey,
    conversationDir,
    pathContext.runtimeWorkspaceRoot,
    sessionScope,
  );
  const chatSessionManager = new AgentMemoryFileManager();
  const { agent, session } = await createMikanAgent({
    services,
    sessionManager: sessionRuntime.sessionManager,
    systemPrompt,
    model,
    thinkingLevel: agentConfig.thinkingLevel,
    tools,
    conversationId,
    retrySettings: { ...DEFAULT_RETRY_SETTINGS, ...agentConfig.retry },
    compactionSettings: { ...DEFAULT_COMPACTION_SETTINGS, ...agentConfig.compaction },
  });

  // Mutable per-run state - event handler references this
  const runState = createRunState();
  attachSessionEventHandlers({ session, runState, model, agentConfig });

  return {
    syncChatHistory(currentMessageId?: string): void {
      chatSessionManager.syncSessionManager({
        conversationDir,
        sessionKey,
        sessionManager: sessionRuntime.sessionManager,
        currentMessageId,
      });
    },

    async run(
      message: ConversationMessage,
      responder: ConversationResponder,
      platform: MessagingInfo,
    ): Promise<{ stopReason: string; errorMessage?: string }> {
      const sessionUuid = sessionRuntime.sessionUuid;
      const sessionManager = sessionRuntime.sessionManager;
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
        sessionManager,
        session,
        agent,
        setEventContext,
        setSandboxContext,
        setUploadFunction,
        pathContext,
        resourceLoader,
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

      await session.prompt(
        prepared.userMessage,
        prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : undefined,
      );

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

export function translateRuntimePathToHost(
  runtimePath: string,
  pathContext: RuntimePathContext,
): string {
  return pathContext.runtimeToHostPath?.(runtimePath) ?? runtimePath;
}

export function translateAttachPathToHost(
  filePath: string,
  pathContext: RuntimePathContext,
): string {
  const runtimePath = posix.isAbsolute(filePath)
    ? filePath
    : posix.join(pathContext.runtimeWorkspaceRoot, filePath);
  return translateRuntimePathToHost(runtimePath, pathContext);
}
