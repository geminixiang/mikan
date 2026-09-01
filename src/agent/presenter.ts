import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import type { HarnessEvent, MikanAgentSession } from "../harness/index.js";
import {
  mergeSubagentProgress,
  parseSubagentProgressSnapshot,
  renderSubagentDashboard,
  settleSubagentProgress,
} from "../subagent-progress.js";
import type { ConversationResponder, SubagentProgressSnapshot } from "../adapter.js";
import type { AgentEventPayload } from "../types.js";
import type { resolveConversationSettings } from "../config.js";
import * as log from "../log.js";
import {
  addLifecycleBreadcrumb,
  metricAttributes,
  reportUserFacingError,
} from "../observability/sentry.js";
import * as Sentry from "@sentry/node";
import { emitAgentEvent } from "../agent-events.js";
import { appendTriggerAttribution } from "./prompt.js";
import type { RunnerSessionState, UsageReportContext } from "./types.js";

function createEmptyUsageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createRunState(): RunnerSessionState {
  return {
    responder: null,
    logCtx: null,
    queue: null,
    pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
    toolProgress: new Map<string, { label: string; status: "running" | "done" | "error" }>(),
    subagentProgress: new Map<string, SubagentProgressSnapshot>(),
    completedSubagentProgress: [],
    subagentToolCalls: new Set<string>(),
    subagentProgressShown: false,
    suppressResponseDeltas: false,
    lastSubagentProgressAt: 0,
    toolProgressTimer: undefined,
    totalUsage: createEmptyUsageTotals(),
    llmCallCount: 0,
    stopReason: "stop",
    errorMessage: undefined,
    reportedLlmError: false,
    finalResponseHandledByTool: false,
    triggerAttribution: undefined,
  };
}

export function resetRunState(
  runState: RunnerSessionState,
  context: {
    responder: ConversationResponder;
    sessionConversation: string;
    userName: string | undefined;
    sessionUuid: string;
    triggerAttribution: string | undefined;
  },
): void {
  runState.responder = context.responder;
  runState.logCtx = {
    conversationId: context.sessionConversation,
    userName: context.userName,
    conversationName: undefined,
    sessionId: context.sessionUuid,
  };
  runState.pendingTools.clear();
  runState.toolProgress.clear();
  runState.subagentProgress.clear();
  runState.completedSubagentProgress = [];
  runState.subagentToolCalls.clear();
  runState.subagentProgressShown = false;
  runState.suppressResponseDeltas = false;
  runState.lastSubagentProgressAt = 0;
  if (runState.toolProgressTimer) clearTimeout(runState.toolProgressTimer);
  runState.toolProgressTimer = undefined;
  runState.totalUsage = createEmptyUsageTotals();
  runState.llmCallCount = 0;
  runState.stopReason = "stop";
  runState.errorMessage = undefined;
  runState.reportedLlmError = false;
  runState.finalResponseHandledByTool = false;
  runState.triggerAttribution = context.triggerAttribution;
}

export function createRunQueue(
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

function getFinalAssistantText(session: MikanAgentSession): string {
  const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
  return contentText(lastAssistant?.content ?? []);
}

export function isEventTriggerAttribution(triggerAttribution: string | undefined): boolean {
  return triggerAttribution?.startsWith("[event:") === true;
}

function extractToolLabel(toolName: string, args: unknown): string {
  const label = (args as { label?: unknown } | undefined)?.label;
  if (typeof label !== "string") return toolName;
  return label.trim() || toolName;
}

/** Non-subagent tool activity lines; subagent calls render as the dashboard. */
function formatToolProgress(runState: RunnerSessionState): string {
  const lines = Array.from(runState.toolProgress.entries()).flatMap(([toolCallId, item]) => {
    if (runState.subagentToolCalls.has(toolCallId)) return [];
    const marker = item.status === "running" ? "•" : item.status === "error" ? "✗" : "✓";
    return [`${marker} ${item.label}`];
  });
  return lines.join("\n");
}

function formatResponseWithToolProgress(text: string, runState: RunnerSessionState): string {
  const progress = formatToolProgress(runState);
  return [progress, text].filter(Boolean).join("\n\n");
}

/**
 * The one dashboard render path. A responder that overrides
 * `replaceSubagentProgress` converts the snapshot for a pipeline that is not
 * response-source Markdown (Telegram HTML); every other platform receives the
 * Markdown dashboard — "dashboard, blank line, answer" — through
 * `replaceResponse`, the same conversion as any response.
 */
async function replaceWithSubagentDashboard(
  responder: ConversationResponder,
  snapshot: SubagentProgressSnapshot,
  finalText?: string,
  options?: { createOverflowLink?: () => string },
): Promise<void> {
  if (responder.replaceSubagentProgress) {
    await responder.replaceSubagentProgress(snapshot, finalText);
    return;
  }
  const dashboard = renderSubagentDashboard(snapshot);
  await responder.replaceResponse(finalText ? `${dashboard}\n\n${finalText}` : dashboard, options);
}

async function replaceResponseWithToolProgress(
  responder: ConversationResponder,
  runState: RunnerSessionState,
  subagentProgress = mergeSubagentProgress([...runState.subagentProgress.values()]),
): Promise<void> {
  if (subagentProgress) {
    await replaceWithSubagentDashboard(responder, subagentProgress);
    return;
  }
  const progress = formatToolProgress(runState);
  if (progress) await responder.replaceResponse(progress);
}

const TOOL_PROGRESS_DEBOUNCE_MS = 500;
const SUBAGENT_PROGRESS_THROTTLE_MS = 2000;

function subagentProgressDelay(runState: RunnerSessionState): number {
  if (!runState.subagentProgressShown) return 0;
  return Math.max(0, runState.lastSubagentProgressAt + SUBAGENT_PROGRESS_THROTTLE_MS - Date.now());
}

function scheduleToolProgressUpdate(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): void {
  if (runState.toolProgressTimer) return;
  const subagentProgress = mergeSubagentProgress([...runState.subagentProgress.values()]);
  const delay = subagentProgress ? subagentProgressDelay(runState) : TOOL_PROGRESS_DEBOUNCE_MS;
  runState.toolProgressTimer = setTimeout(() => {
    runState.toolProgressTimer = undefined;
    const snapshot = mergeSubagentProgress([...runState.subagentProgress.values()]);
    if (snapshot) {
      runState.subagentProgressShown = true;
      runState.lastSubagentProgressAt = Date.now();
    }
    runState.queue?.enqueue(
      () => replaceResponseWithToolProgress(responder, runState, snapshot),
      "tool progress update",
    );
  }, delay);
  runState.toolProgressTimer.unref();
}

function flushToolProgressUpdate(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): void {
  if (runState.toolProgressTimer) clearTimeout(runState.toolProgressTimer);
  runState.toolProgressTimer = undefined;
  const subagentProgress = mergeSubagentProgress([...runState.subagentProgress.values()]);
  if (subagentProgress) {
    runState.subagentProgressShown = true;
    runState.lastSubagentProgressAt = Date.now();
  }
  runState.queue?.enqueue(
    () => replaceResponseWithToolProgress(responder, runState, subagentProgress),
    "tool progress update",
  );
}

function extractSubagentProgress(partialResult: unknown): SubagentProgressSnapshot | undefined {
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  return parseSubagentProgressSnapshot((details as { progress?: unknown }).progress);
}

async function finalizeErrorResponse(
  responder: ConversationResponder,
  runState: RunnerSessionState,
  options?: {
    platform?: string;
    model?: Model<Api>;
    sessionConversation?: string;
    sessionUuid?: string;
  },
): Promise<void> {
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
    await responder.respondDiagnostic(`Error: ${runState.errorMessage}`, { style: "error" });
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
}

export async function finalizeRunResponse(
  responder: ConversationResponder,
  session: MikanAgentSession,
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
    await finalizeErrorResponse(responder, runState, options);
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
    const finalResponse = appendTriggerAttribution(
      finalText,
      options?.triggerAttribution,
      options?.triggerSessionLink,
    );
    const finalDashboard = mergeSubagentProgress(runState.completedSubagentProgress);
    if (finalDashboard) {
      await replaceWithSubagentDashboard(responder, finalDashboard, finalResponse, {
        createOverflowLink: options?.createOverflowLink,
      });
      return;
    }
    await responder.replaceResponse(formatResponseWithToolProgress(finalResponse, runState), {
      createOverflowLink: options?.createOverflowLink,
    });
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

export async function reportUsageSummary(ctx: UsageReportContext): Promise<void> {
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

export function formatAgentActorName(userName: string | undefined, fallback: string): string {
  return userName ? `DM:${userName}` : fallback;
}

export function sendAgentEvent(payload: {
  sessionId: string;
  actorName: string;
  event: AgentEventPayload;
}): void {
  emitAgentEvent({ source: "mikan", ...payload });
}

// ponytail: additive SSE mirror only; keep responder rendering here until another frontend needs the same stream.
type PresenterEventContext = {
  runState: RunnerSessionState;
  responder: ConversationResponder;
  logCtx: NonNullable<RunnerSessionState["logCtx"]>;
  queue: NonNullable<RunnerSessionState["queue"]>;
  pendingTools: RunnerSessionState["pendingTools"];
  baseAttrs: { channel_id: string; session_id: string | undefined };
  agentEventSessionId: string;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
};

type ToolStartEvent = Extract<HarnessEvent, { type: "tool_execution_start" }>;
type ToolUpdateEvent = Extract<HarnessEvent, { type: "tool_execution_update" }>;
type ToolEndEvent = Extract<HarnessEvent, { type: "tool_execution_end" }>;
type MessageStartEvent = Extract<HarnessEvent, { type: "message_start" }>;
type MessageUpdateEvent = Extract<HarnessEvent, { type: "message_update" }>;
type MessageEndEvent = Extract<HarnessEvent, { type: "message_end" }>;
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;
type LifecycleEvent = Extract<
  HarnessEvent,
  { type: "compaction_start" | "compaction_end" | "auto_retry_start" | "budget_exceeded" }
>;

function handleToolStart(event: ToolStartEvent, context: PresenterEventContext): void {
  const { runState, responder, logCtx, queue, pendingTools, baseAttrs, agentEventSessionId } =
    context;
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
  if (event.toolName === "subagent") {
    runState.subagentToolCalls.add(event.toolCallId);
  } else {
    queue.enqueue(
      () => replaceResponseWithToolProgress(responder, runState),
      "tool progress update",
    );
  }
  addLifecycleBreadcrumb("agent.tool.started", { tool: event.toolName, ...baseAttrs });
  log.logToolStart(logCtx, event.toolName, label, event.args as Record<string, unknown>);
}

function handleToolUpdate(event: ToolUpdateEvent, context: PresenterEventContext): void {
  const subagentProgress = extractSubagentProgress(event.partialResult);
  if (!subagentProgress) return;
  context.runState.subagentProgress.set(event.toolCallId, subagentProgress);
  context.runState.subagentToolCalls.add(event.toolCallId);
  context.runState.suppressResponseDeltas = true;
  scheduleToolProgressUpdate(context.responder, context.runState);
}

function recordToolMetrics(
  event: ToolEndEvent,
  durationMs: number,
  context: PresenterEventContext,
): void {
  Sentry.metrics.count("agent.tool.calls", 1, {
    attributes: metricAttributes({
      tool: event.toolName,
      error: String(event.isError),
      ...context.baseAttrs,
    }),
  });
  Sentry.metrics.distribution("agent.tool.duration", durationMs, {
    unit: "millisecond",
    attributes: metricAttributes({ tool: event.toolName, ...context.baseAttrs }),
  });
  addLifecycleBreadcrumb("agent.tool.completed", {
    tool: event.toolName,
    error: event.isError,
    duration_ms: durationMs,
    ...context.baseAttrs,
  });
}

function handleToolEnd(event: ToolEndEvent, context: PresenterEventContext): void {
  const { runState, responder, logCtx, pendingTools, agentEventSessionId } = context;
  const resultStr = extractToolResultText(event.result);
  const pending = pendingTools.get(event.toolCallId);
  sendAgentEvent({
    sessionId: agentEventSessionId,
    actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
    event: { kind: "toolEnd", toolId: event.toolCallId },
  });
  const progress = runState.toolProgress.get(event.toolCallId);
  if (progress) progress.status = event.isError ? "error" : "done";
  const subagentProgress = runState.subagentProgress.get(event.toolCallId);
  if (subagentProgress) {
    runState.subagentProgress.set(
      event.toolCallId,
      settleSubagentProgress(subagentProgress, event.isError),
    );
  }
  flushToolProgressUpdate(responder, runState);
  const completedProgress = runState.subagentProgress.get(event.toolCallId);
  if (completedProgress) runState.completedSubagentProgress.push(completedProgress);
  runState.subagentProgress.delete(event.toolCallId);
  pendingTools.delete(event.toolCallId);
  const durationMs = pending ? Date.now() - pending.startTime : 0;
  recordToolMetrics(event, durationMs, context);
  if (event.isError) {
    log.logToolError(logCtx, event.toolName, durationMs, resultStr);
    return;
  }
  log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
  if (event.toolName === "slack_blockkit") runState.finalResponseHandledByTool = true;
}

function handleMessageStart(event: MessageStartEvent, context: PresenterEventContext): void {
  if (event.message.role !== "assistant") return;
  context.runState.llmCallCount += 1;
  sendAgentEvent({
    sessionId: context.agentEventSessionId,
    actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
    event: { kind: "sessionStart" },
  });
  addLifecycleBreadcrumb("agent.llm.call.started", {
    call_index: context.runState.llmCallCount,
    provider: context.model.provider,
    model: context.agentConfig.model,
    ...context.baseAttrs,
  });
  log.logResponseStart(context.logCtx);
}

function handleMessageUpdate(event: MessageUpdateEvent, context: PresenterEventContext): void {
  const update = event.assistantMessageEvent;
  if (update.type !== "text_delta" || !update.delta) return;
  sendAgentEvent({
    sessionId: context.agentEventSessionId,
    actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
    event: { kind: "responseDelta", delta: update.delta },
  });
  if (context.responder.appendResponseDelta && !context.runState.suppressResponseDeltas) {
    context.queue.enqueue(async () => {
      await context.responder.appendResponseDelta?.(update.delta);
    }, "response delta");
  }
}

function recordAssistantUsage(message: AssistantMessage, context: PresenterEventContext): void {
  if (!message.usage) return;
  const { totalUsage } = context.runState;
  totalUsage.input += message.usage.input;
  totalUsage.output += message.usage.output;
  totalUsage.cacheRead += message.usage.cacheRead;
  totalUsage.cacheWrite += message.usage.cacheWrite;
  totalUsage.cost.input += message.usage.cost.input;
  totalUsage.cost.output += message.usage.cost.output;
  totalUsage.cost.cacheRead += message.usage.cost.cacheRead;
  totalUsage.cost.cacheWrite += message.usage.cost.cacheWrite;
  totalUsage.cost.total += message.usage.cost.total;

  const attributes = metricAttributes({
    provider: context.model.provider,
    model: context.agentConfig.model,
    ...context.baseAttrs,
    stop_reason: message.stopReason,
    error: Boolean(message.errorMessage),
  });
  Sentry.metrics.count("agent.llm.calls", 1, { attributes });
  Sentry.metrics.distribution("agent.llm.tokens_in", message.usage.input, { attributes });
  Sentry.metrics.distribution("agent.llm.tokens_out", message.usage.output, { attributes });
  if (message.usage.cacheRead > 0) {
    Sentry.metrics.distribution("agent.llm.cache_read", message.usage.cacheRead, { attributes });
  }
  if (message.usage.cacheWrite > 0) {
    Sentry.metrics.distribution("agent.llm.cache_write", message.usage.cacheWrite, { attributes });
  }
  Sentry.metrics.distribution("agent.llm.cost_per_turn", message.usage.cost.total, { attributes });
  addLifecycleBreadcrumb("agent.llm.call.completed", {
    call_index: context.runState.llmCallCount,
    provider: context.model.provider,
    model: context.agentConfig.model,
    stop_reason: message.stopReason,
    error: Boolean(message.errorMessage),
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    cost_total_usd: message.usage.cost.total,
  });
}

function presentAssistantMessage(message: AssistantMessage, context: PresenterEventContext): void {
  const thinkingParts: string[] = [];
  const textParts: string[] = [];
  const hasToolCall = message.content.some((part) =>
    ["tool_use", "toolCall", "tool-call"].includes((part as { type?: string }).type ?? ""),
  );
  for (const part of message.content) {
    if (part.type === "thinking") thinkingParts.push(part.thinking);
    else if (part.type === "text") textParts.push(part.text);
  }
  for (const thinking of thinkingParts) {
    log.logThinking(context.logCtx, thinking);
    context.queue.enqueue(() => context.responder.respond(`_${thinking}_`), "thinking main");
    context.queue.enqueue(
      () => context.responder.respondDiagnostic(`_${thinking}_`),
      "thinking diagnostic",
    );
  }

  const text = textParts.join("\n");
  if (!text.trim() || hasToolCall || context.runState.finalResponseHandledByTool) return;
  const finalText = appendTriggerAttribution(
    formatResponseWithToolProgress(text, context.runState),
    context.runState.triggerAttribution,
  );
  log.logResponse(context.logCtx, text);
  sendAgentEvent({
    sessionId: context.agentEventSessionId,
    actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
    event: { kind: "responseFinal", text: finalText },
  });
  sendAgentEvent({
    sessionId: context.agentEventSessionId,
    actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
    event: { kind: "turnEnd" },
  });
  // Subagent dashboard finalization must preserve "dashboard, blank line, answer".
  if (context.runState.completedSubagentProgress.length > 0) return;
  if (context.responder.finishResponse) {
    context.queue.enqueue(async () => {
      await context.responder.finishResponse?.(finalText);
    }, "response finish");
  } else {
    context.queue.enqueue(() => context.responder.respond(finalText), "response main");
  }
}

function handleMessageEnd(event: MessageEndEvent, context: PresenterEventContext): void {
  if (event.message.role !== "assistant") return;
  const message = event.message;
  if (message.stopReason) {
    context.runState.stopReason = message.stopReason;
    // The settling message clears any stale error left by a recovered retry.
    context.runState.errorMessage = message.errorMessage;
  }
  recordAssistantUsage(message, context);
  presentAssistantMessage(message, context);
}

function handleLifecycleEvent(event: LifecycleEvent, context: PresenterEventContext): void {
  if (event.type === "compaction_start") {
    const text = "_Compacting context..._";
    log.logInfo(`Auto-compaction started (reason: ${event.reason})`);
    sendAgentEvent({
      sessionId: context.agentEventSessionId,
      actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
      event: { kind: "diagnostic", text },
    });
    context.queue.enqueue(() => context.responder.respond(text), "compaction start");
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
      sessionId: context.agentEventSessionId,
      actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
      event: { kind: "sessionStart" },
    });
    const text = `_Retrying (${event.attempt}/${event.maxAttempts})..._`;
    sendAgentEvent({
      sessionId: context.agentEventSessionId,
      actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
      event: { kind: "diagnostic", text },
    });
    context.queue.enqueue(() => context.responder.respond(text), "retry");
    return;
  }

  log.logWarning(
    "Run stopped by budget circuit breaker",
    `${event.reason} (tokens=${event.tokens}, cost=${event.costUsd.toFixed(2)}, calls=${event.llmCalls}, ${event.durationMs}ms)`,
  );
  const text = `_Stopped: run budget exceeded (${event.reason})_`;
  sendAgentEvent({
    sessionId: context.agentEventSessionId,
    actorName: formatAgentActorName(context.logCtx.userName, context.logCtx.conversationId),
    event: { kind: "diagnostic", text },
  });
  context.queue.enqueue(
    () => context.responder.respondDiagnostic(text, { style: "error" }),
    "budget exceeded",
  );
}

function handlePresenterEvent(event: HarnessEvent, context: PresenterEventContext): void {
  switch (event.type) {
    case "tool_execution_start":
      handleToolStart(event, context);
      return;
    case "tool_execution_update":
      handleToolUpdate(event, context);
      return;
    case "tool_execution_end":
      handleToolEnd(event, context);
      return;
    case "message_start":
      handleMessageStart(event, context);
      return;
    case "message_update":
      handleMessageUpdate(event, context);
      return;
    case "message_end":
      handleMessageEnd(event, context);
      return;
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "budget_exceeded":
      handleLifecycleEvent(event, context);
      return;
    default:
      return;
  }
}

export function attachSessionEventHandlers(params: {
  session: MikanAgentSession;
  runState: RunnerSessionState;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
}): void {
  const { session, runState, model, agentConfig } = params;
  session.subscribe((event) => {
    if (!runState.responder || !runState.logCtx || !runState.queue) return;
    handlePresenterEvent(event, {
      runState,
      responder: runState.responder,
      logCtx: runState.logCtx,
      queue: runState.queue,
      pendingTools: runState.pendingTools,
      baseAttrs: {
        channel_id: runState.logCtx.conversationId,
        session_id: runState.logCtx.sessionId,
      },
      agentEventSessionId: runState.logCtx.sessionId ?? runState.logCtx.conversationId,
      model,
      agentConfig,
    });
  });
}
