import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import type {
  HarnessEvent,
  RunPresentation,
  RunnerSessionState,
  UsageReportContext,
} from "./types.js";
import type { MikanAgentSession } from "./session.js";
import {
  mergeSubagentProgress,
  parseSubagentProgressSnapshot,
  renderSubagentDashboard,
  settleSubagentProgress,
} from "./tools/subagent.js";
import type { ConversationResponder, SubagentProgressSnapshot } from "../types.js";
import type { resolveConversationSettings } from "../settings/index.js";
import {
  addLifecycleEvent,
  metricAttributes,
  recordCounter,
  recordDistribution,
  recordGauge,
  reportUserFacingError,
  startOperationSpan,
  updateActiveSpanAttribution,
  type ObservabilitySpan,
} from "../observability/index.js";
import { appendTriggerAttribution } from "./prompt.js";

import * as log from "../log.js";

type LlmOperationSpan = {
  span: ObservabilitySpan;
  startedAt: number;
  firstTokenAt?: number;
};

type RunOperationSpans = {
  llm: LlmOperationSpan[];
  tools: Map<string, ObservabilitySpan>;
};

const operationSpans = new WeakMap<RunnerSessionState, RunOperationSpans>();

function spansFor(runState: RunnerSessionState): RunOperationSpans {
  let spans = operationSpans.get(runState);
  if (!spans) {
    spans = { llm: [], tools: new Map() };
    operationSpans.set(runState, spans);
  }
  return spans;
}

function operationError(name: "AbortError" | "LLMError" | "ToolError"): Error {
  const error = new Error();
  error.name = name;
  return error;
}

function endOutstandingOperationSpans(runState: RunnerSessionState): void {
  const spans = operationSpans.get(runState);
  if (!spans) return;
  const aborted = operationError("AbortError");
  for (const entry of spans.llm) entry.span.end({ error: aborted });
  for (const span of spans.tools.values()) span.end({ error: aborted });
  operationSpans.delete(runState);
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

function createRunStateDefaults(): RunnerSessionState {
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
    toolCallCount: 0,
    toolErrorCount: 0,
    toolInputCharacters: 0,
    toolOutputCharacters: 0,
    assistantMessageCount: 0,
    outputCharacters: 0,
    reasoningTokens: 0,
    retryCount: 0,
    compactionCount: 0,
    budgetExceeded: false,
    firstTokenLatencyMs: undefined,
    responseModel: undefined,
    stopReason: "stop",
    errorMessage: undefined,
    reportedLlmError: false,
    finalResponseHandledByTool: false,
    triggerAttribution: undefined,
  };
}

export function createRunState(): RunnerSessionState {
  return createRunStateDefaults();
}

export function activateRunPresentation(
  runState: RunnerSessionState,
  context: {
    responder: ConversationResponder;
    sessionConversation: string;
    userName: string | undefined;
    sessionUuid: string;
    triggerAttribution: string | undefined;
  },
): RunPresentation {
  endOutstandingOperationSpans(runState);
  if (runState.toolProgressTimer) clearTimeout(runState.toolProgressTimer);
  Object.assign(runState, createRunStateDefaults(), {
    responder: context.responder,
    logCtx: {
      conversationId: context.sessionConversation,
      userName: context.userName,
      conversationName: undefined,
      sessionId: context.sessionUuid,
    },
    triggerAttribution: context.triggerAttribution,
  });

  const { responder } = context;
  let queueChain = Promise.resolve();
  runState.queue = {
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
          } catch {}
        }
      });
    },
  };
  return {
    wait: () => queueChain,
    dispose(): void {
      endOutstandingOperationSpans(runState);
      if (runState.toolProgressTimer) clearTimeout(runState.toolProgressTimer);
      runState.toolProgressTimer = undefined;
      runState.responder = null;
      runState.logCtx = null;
      runState.queue = null;
    },
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
  const text = typeof label === "string" ? label.trim() || toolName : toolName;
  if ((toolName === "jev" || toolName === "jev_browser") && text !== toolName) {
    return `${toolName} · ${text}`;
  }
  return text;
}

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

function markSubagentProgressShown(runState: RunnerSessionState, snapshot: unknown): void {
  if (!snapshot) return;
  runState.subagentProgressShown = true;
  runState.lastSubagentProgressAt = Date.now();
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
    markSubagentProgressShown(runState, snapshot);
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
  markSubagentProgressShown(runState, subagentProgress);
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
    triggerSessionLink?: string;
    createOverflowLink?: () => string;
    platform?: string;
    model?: Model<Api>;
    sessionConversation?: string;
    sessionUuid?: string;
    initialTask?: boolean;
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
  if (finalText.trim().startsWith("[SILENT]")) {
    await deleteForSilentResponse(responder);
    return;
  }
  if (!finalText.trim()) return;
  const published = await publishFinalResponse(responder, runState, finalText, options);
  const didWork = Object.keys(session.getLastRunStats().toolCallCounts).some(
    (name) => !["task_status", "start_task", "react"].includes(name),
  );
  if (published && runState.stopReason === "stop" && (didWork || options?.initialTask))
    await responder.notifyCompletion?.();
}

async function deleteForSilentResponse(responder: ConversationResponder): Promise<void> {
  try {
    await responder.deleteResponse();
    log.logInfo("Silent response - deleted message and thread");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.logWarning("Failed to delete message for silent response", errMsg);
  }
}

function resolveSingleCompletedProfile(runState: RunnerSessionState): string | undefined {
  const nodes = runState.completedSubagentProgress.flatMap((snapshot) => snapshot.nodes);
  if (nodes.length === 0) return undefined;
  const profiles = new Set(nodes.map((node) => node.profile));
  if (profiles.size !== 1) return undefined;
  const [profile] = profiles;
  if (!profile) return undefined;
  return nodes.every((node) => node.status === "completed") ? profile : undefined;
}

async function publishFinalResponse(
  responder: ConversationResponder,
  runState: RunnerSessionState,
  finalText: string,
  options?: {
    triggerSessionLink?: string;
    createOverflowLink?: () => string;
    platform?: string;
    sessionConversation?: string;
    sessionUuid?: string;
  },
): Promise<boolean> {
  try {
    const finalResponse = appendTriggerAttribution(
      finalText,
      runState.triggerAttribution,
      options?.triggerSessionLink,
    );
    const finalDashboard = mergeSubagentProgress(runState.completedSubagentProgress);
    if (finalDashboard) {
      const resolvedProfile = resolveSingleCompletedProfile(runState);
      if (resolvedProfile && responder.respondAsRole) {
        await replaceWithSubagentDashboard(responder, finalDashboard, undefined, {
          createOverflowLink: options?.createOverflowLink,
        });
        await responder.respondAsRole(resolvedProfile, finalResponse);
        return true;
      }
      await replaceWithSubagentDashboard(responder, finalDashboard, finalResponse, {
        createOverflowLink: options?.createOverflowLink,
      });
      return true;
    }
    await responder.replaceResponse(formatResponseWithToolProgress(finalResponse, runState), {
      createOverflowLink: options?.createOverflowLink,
    });
    return true;
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
    return false;
  }
}

export async function reportUsageSummary(ctx: UsageReportContext): Promise<void> {
  const {
    session,
    runState,
    responder,
    platform,
    model,
    sessionConversation,
    sessionUuid,
    waitForQueue,
  } = ctx;
  const lastAssistantMessage = session.messages.findLast(
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
    model: model.id,
    channel_id: sessionConversation,
    session_id: sessionUuid,
    stop_reason: runState.stopReason,
    llm_calls: runState.llmCallCount,
  });
  recordDistribution("agent.run.tokens_in", totalUsage.input, {
    attributes: runMetricAttributes,
  });
  recordDistribution("agent.run.tokens_out", totalUsage.output, {
    attributes: runMetricAttributes,
  });
  recordDistribution("agent.run.cache_read", totalUsage.cacheRead, {
    attributes: runMetricAttributes,
  });
  recordDistribution("agent.run.cache_write", totalUsage.cacheWrite, {
    attributes: runMetricAttributes,
  });
  recordDistribution("agent.run.cost", totalUsage.cost.total, {
    attributes: runMetricAttributes,
  });
  const contextUtilization = contextTokens / contextWindow;
  recordGauge("agent.context.utilization", contextUtilization, {
    unit: "ratio",
    attributes: runMetricAttributes,
  });
  updateActiveSpanAttribution({
    "gen_ai.request.model": model.id,
    "gen_ai.response.model": runState.responseModel ?? model.id,
    "gen_ai.usage.input_tokens": totalUsage.input + totalUsage.cacheRead + totalUsage.cacheWrite,
    "gen_ai.usage.input_tokens.cached": totalUsage.cacheRead,
    "gen_ai.usage.input_tokens.cache_write": totalUsage.cacheWrite,
    "gen_ai.usage.output_tokens": totalUsage.output,
    "gen_ai.usage.output_tokens.reasoning": runState.reasoningTokens,
    "mikan.usage.cost_usd": totalUsage.cost.total,
    "mikan.context.utilization": contextUtilization,
    "mikan.llm.call_count": runState.llmCallCount,
    "mikan.tool.call_count": runState.toolCallCount,
    "mikan.tool.error_count": runState.toolErrorCount,
    "mikan.tool.input.characters": runState.toolInputCharacters,
    "mikan.tool.output.characters": runState.toolOutputCharacters,
    "mikan.output.message_count": runState.assistantMessageCount,
    "mikan.output.characters": runState.outputCharacters,
    "mikan.retry.count": runState.retryCount,
    "mikan.compaction.count": runState.compactionCount,
    "mikan.budget.exceeded": runState.budgetExceeded,
    ...(runState.firstTokenLatencyMs === undefined
      ? {}
      : { "mikan.response.first_token_ms": runState.firstTokenLatencyMs }),
  });

  const summary = log.logUsageSummary(
    runState.logCtx!,
    runState.totalUsage,
    contextTokens,
    contextWindow,
  );
  const toolNames = Object.keys(session.getLastRunStats().toolCallCounts);
  const statusOnly = toolNames.length > 0 && toolNames.every((name) => name === "task_status");
  if (
    platform.diagnostics?.showUsageSummary === true &&
    !runState.finalResponseHandledByTool &&
    !statusOnly
  ) {
    runState.queue!.enqueue(
      () => responder.respondDiagnostic(summary, { style: "muted" }),
      "usage summary",
    );
    await waitForQueue();
  }
}

function toolResultContentText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("content" in result)) return undefined;
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const textParts = (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text);
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  return toolResultContentText(result) ?? JSON.stringify(result);
}

function serializedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function toolCategory(name: string): string {
  if (["read", "write", "edit", "bash"].includes(name)) return "sandbox";
  if (name === "subagent") return "agent";
  if (name.startsWith("mcp__")) return "mcp";
  if (name.startsWith("github_")) return "github";
  if (name === "slack_blockkit") return "platform";
  return "function";
}

type PresenterEventContext = {
  runState: RunnerSessionState;
  responder: ConversationResponder;
  logCtx: NonNullable<RunnerSessionState["logCtx"]>;
  queue: NonNullable<RunnerSessionState["queue"]>;
  baseAttrs: { channel_id: string; session_id: string | undefined };
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
  const { runState, responder, logCtx, queue, baseAttrs } = context;
  const args = (event.args ?? {}) as { label?: string };
  const label = args.label || event.toolName;
  runState.toolCallCount += 1;
  runState.toolInputCharacters += serializedLength(event.args);
  runState.pendingTools.set(event.toolCallId, {
    toolName: event.toolName,
    args: event.args,
    startTime: Date.now(),
  });
  if (event.toolName === "start_task") return;
  if (event.toolName !== "task_status") {
    runState.toolProgress.set(event.toolCallId, {
      label: extractToolLabel(event.toolName, event.args),
      status: "running",
    });
  }
  if (event.toolName === "subagent") {
    runState.subagentToolCalls.add(event.toolCallId);
  } else if (event.toolName !== "task_status") {
    queue.enqueue(
      () => replaceResponseWithToolProgress(responder, runState),
      "tool progress update",
    );
  }
  spansFor(runState).tools.set(
    event.toolCallId,
    startOperationSpan(
      `execute_tool ${event.toolName}`,
      metricAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": event.toolName,
        "gen_ai.tool.type": "function",
        "mikan.tool.category": toolCategory(event.toolName),
        "mikan.tool.input.characters": serializedLength(event.args),
        "openinference.span.kind": "TOOL",
        ...baseAttrs,
      }),
    ),
  );
  addLifecycleEvent("agent.tool.started", { tool: event.toolName, ...baseAttrs });
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
  recordCounter(
    "agent.tool.calls",
    1,
    metricAttributes({
      tool: event.toolName,
      error: String(event.isError),
      ...context.baseAttrs,
    }),
  );
  recordDistribution("agent.tool.duration", durationMs, {
    unit: "millisecond",
    attributes: metricAttributes({ tool: event.toolName, ...context.baseAttrs }),
  });
  addLifecycleEvent("agent.tool.completed", {
    tool: event.toolName,
    error: event.isError,
    duration_ms: durationMs,
    ...context.baseAttrs,
  });
}

function handleToolEnd(event: ToolEndEvent, context: PresenterEventContext): void {
  const { runState, responder, logCtx } = context;
  const resultStr = extractToolResultText(event.result);
  const outputCharacters = serializedLength(event.result);
  runState.toolOutputCharacters += outputCharacters;
  if (event.isError) runState.toolErrorCount += 1;
  const pending = runState.pendingTools.get(event.toolCallId);
  if (event.toolName === "start_task") {
    runState.pendingTools.delete(event.toolCallId);
    if (!event.isError) runState.finalResponseHandledByTool = true;
    else
      reportUserFacingError(new Error("Task admission failed"), {
        domain: "mikan",
        surface: "task_handoff",
        operation: "admit_task",
        severity: "error",
        context: { sessionId: logCtx.sessionId, toolCallId: event.toolCallId },
      });
    return;
  }
  const progress = runState.toolProgress.get(event.toolCallId);
  if (progress) progress.status = event.isError ? "error" : "done";
  const subagentProgress = runState.subagentProgress.get(event.toolCallId);
  if (subagentProgress) {
    runState.subagentProgress.set(
      event.toolCallId,
      settleSubagentProgress(subagentProgress, event.isError),
    );
  }
  if (event.toolName !== "task_status") flushToolProgressUpdate(responder, runState);
  const completedProgress = runState.subagentProgress.get(event.toolCallId);
  if (completedProgress) runState.completedSubagentProgress.push(completedProgress);
  runState.subagentProgress.delete(event.toolCallId);
  runState.pendingTools.delete(event.toolCallId);
  const durationMs = pending ? Date.now() - pending.startTime : 0;
  const toolSpan = spansFor(runState).tools.get(event.toolCallId);
  toolSpan?.end({
    attributes: metricAttributes({
      "gen_ai.tool.name": event.toolName,
      "gen_ai.tool.type": "function",
      "mikan.tool.category": toolCategory(event.toolName),
      "mikan.tool.output.characters": outputCharacters,
      "openinference.span.kind": "TOOL",
      duration_ms: durationMs,
      ...context.baseAttrs,
    }),
    ...(event.isError ? { error: operationError("ToolError") } : {}),
  });
  spansFor(runState).tools.delete(event.toolCallId);
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
  spansFor(context.runState).llm.push({
    span: startOperationSpan(
      `chat ${context.model.id}`,
      metricAttributes({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": context.model.provider,
        "gen_ai.request.model": context.model.id,
        "openinference.span.kind": "LLM",
        "llm.provider": context.model.provider,
        "llm.model_name": context.model.id,
        ...context.baseAttrs,
      }),
    ),
    startedAt: Date.now(),
  });
  addLifecycleEvent("agent.llm.call.started", {
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
  const llmEntry = spansFor(context.runState).llm[0];
  if (llmEntry && llmEntry.firstTokenAt === undefined) {
    llmEntry.firstTokenAt = Date.now();
    context.runState.firstTokenLatencyMs ??= llmEntry.firstTokenAt - llmEntry.startedAt;
  }
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
  context.runState.reasoningTokens += message.usage.reasoning ?? 0;
  context.runState.responseModel = message.responseModel ?? message.model;

  const attributes = metricAttributes({
    provider: context.model.provider,
    model: context.agentConfig.model,
    ...context.baseAttrs,
    stop_reason: message.stopReason,
    error: Boolean(message.errorMessage),
  });
  recordCounter("agent.llm.calls", 1, attributes);
  recordDistribution("agent.llm.tokens_in", message.usage.input, { attributes });
  recordDistribution("agent.llm.tokens_out", message.usage.output, { attributes });
  if (message.usage.cacheRead > 0) {
    recordDistribution("agent.llm.cache_read", message.usage.cacheRead, { attributes });
  }
  if (message.usage.cacheWrite > 0) {
    recordDistribution("agent.llm.cache_write", message.usage.cacheWrite, { attributes });
  }
  recordDistribution("agent.llm.cost_per_turn", message.usage.cost.total, { attributes });
  addLifecycleEvent("agent.llm.call.completed", {
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

function presentThinking(thinking: string, context: PresenterEventContext): void {
  log.logThinking(context.logCtx, thinking);
  context.queue.enqueue(() => context.responder.respond(`_${thinking}_`), "thinking main");
  context.queue.enqueue(
    () => context.responder.respondDiagnostic(`_${thinking}_`),
    "thinking diagnostic",
  );
}

function presentFinalText(text: string, context: PresenterEventContext): void {
  const finalText = appendTriggerAttribution(
    formatResponseWithToolProgress(text, context.runState),
    context.runState.triggerAttribution,
  );
  log.logResponse(context.logCtx, text);
  if (context.runState.completedSubagentProgress.length > 0) return;
  if (context.responder.finishResponse) {
    context.queue.enqueue(async () => {
      await context.responder.finishResponse?.(finalText);
    }, "response finish");
  } else {
    context.queue.enqueue(() => context.responder.respond(finalText), "response main");
  }
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
  for (const thinking of thinkingParts) presentThinking(thinking, context);

  const text = textParts.join("\n");
  if (!text.trim() || hasToolCall || context.runState.finalResponseHandledByTool) return;
  presentFinalText(text, context);
}

function handleMessageEnd(event: MessageEndEvent, context: PresenterEventContext): void {
  if (event.message.role !== "assistant") return;
  const message = event.message;
  context.runState.assistantMessageCount += 1;
  context.runState.outputCharacters += message.content.reduce(
    (total, part) => total + (part.type === "text" ? part.text.length : 0),
    0,
  );
  if (message.stopReason) {
    context.runState.stopReason = message.stopReason;
    context.runState.errorMessage = message.errorMessage;
  }
  recordAssistantUsage(message, context);
  const llmEntry = spansFor(context.runState).llm.shift();
  const inputTokens = message.usage
    ? message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
    : undefined;
  llmEntry?.span.end({
    attributes: metricAttributes({
      "gen_ai.provider.name": context.model.provider,
      "gen_ai.request.model": context.model.id,
      "gen_ai.response.model": message.responseModel ?? message.model,
      "gen_ai.usage.input_tokens": inputTokens,
      "gen_ai.usage.output_tokens": message.usage?.output,
      "gen_ai.usage.input_tokens.cached": message.usage?.cacheRead,
      "gen_ai.usage.input_tokens.cache_write": message.usage?.cacheWrite,
      "gen_ai.usage.output_tokens.reasoning": message.usage?.reasoning,
      "mikan.usage.cost_usd": message.usage?.cost.total,
      "mikan.response.first_token_ms":
        llmEntry?.firstTokenAt === undefined
          ? undefined
          : llmEntry.firstTokenAt - llmEntry.startedAt,
      "mikan.output.characters": message.content.reduce(
        (total, part) => total + (part.type === "text" ? part.text.length : 0),
        0,
      ),
      "openinference.span.kind": "LLM",
      "llm.provider": context.model.provider,
      "llm.model_name": context.model.id,
      "llm.token_count.prompt": inputTokens,
      "llm.token_count.completion": message.usage?.output,
      "llm.token_count.total":
        inputTokens !== undefined && message.usage ? inputTokens + message.usage.output : undefined,
      "llm.token_count.prompt_details.cache_read": message.usage?.cacheRead,
      "llm.token_count.prompt_details.cache_write": message.usage?.cacheWrite,
      stop_reason: message.stopReason,
      ...context.baseAttrs,
    }),
    ...(message.errorMessage ? { error: operationError("LLMError") } : {}),
  });
  presentAssistantMessage(message, context);
}

function handleLifecycleEvent(event: LifecycleEvent, context: PresenterEventContext): void {
  if (event.type === "compaction_start") {
    context.runState.compactionCount += 1;
    const text = "_Compacting context..._";
    log.logInfo(`Auto-compaction started (reason: ${event.reason})`);
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
    context.runState.retryCount += 1;
    log.logWarning(`Retrying (${event.attempt}/${event.maxAttempts})`, event.errorMessage);
    const text = `_Retrying (${event.attempt}/${event.maxAttempts})..._`;
    context.queue.enqueue(() => context.responder.respond(text), "retry");
    return;
  }

  context.runState.budgetExceeded = true;
  log.logWarning(
    "Run stopped by budget circuit breaker",
    `${event.reason} (tokens=${event.tokens}, cost=${event.costUsd.toFixed(2)}, calls=${event.llmCalls}, ${event.durationMs}ms)`,
  );
  const text = `_Stopped: run budget exceeded (${event.reason})_`;
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
      baseAttrs: {
        channel_id: runState.logCtx.conversationId,
        session_id: runState.logCtx.sessionId,
      },
      model,
      agentConfig,
    });
  });
}
