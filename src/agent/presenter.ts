import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import type { MikanAgentSession } from "../harness/index.js";
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
  runState.triggerAttribution = triggerAttribution;
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

async function noopResponderMethod(): Promise<void> {}

export function createNoopResponder(): ConversationResponder {
  return {
    respond: noopResponderMethod,
    replaceResponse: noopResponderMethod,
    respondDiagnostic: noopResponderMethod,
    respondToolResult: noopResponderMethod,
    setTyping: noopResponderMethod,
    setWorking: noopResponderMethod,
    uploadFile: noopResponderMethod,
    deleteResponse: noopResponderMethod,
  };
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
export function attachSessionEventHandlers(params: {
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
      if (event.toolName === "subagent") {
        runState.subagentToolCalls.add(event.toolCallId);
      } else {
        queue.enqueue(
          () => replaceResponseWithToolProgress(responder, runState),
          "tool progress update",
        );
      }
      addLifecycleBreadcrumb("agent.tool.started", {
        tool: event.toolName,
        ...baseAttrs,
      });

      log.logToolStart(logCtx, event.toolName, label, event.args as Record<string, unknown>);
      return;
    }

    if (event.type === "tool_execution_update") {
      const subagentProgress = extractSubagentProgress(event.partialResult);
      if (subagentProgress) {
        runState.subagentProgress.set(event.toolCallId, subagentProgress);
        runState.subagentToolCalls.add(event.toolCallId);
        runState.suppressResponseDeltas = true;
        scheduleToolProgressUpdate(responder, runState);
      }
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
        if (event.toolName === "slack_blockkit") {
          runState.finalResponseHandledByTool = true;
        }
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
        if (responder.appendResponseDelta && !runState.suppressResponseDeltas) {
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
          // The settling message is the authority for both fields: a retry
          // that recovered must clear the earlier attempt's error, or the
          // run would report success and a stale errorMessage together.
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
          // A run that produced a subagent dashboard finalizes through it:
          // finalizeRunResponse renders "dashboard, blank line, answer", and a
          // finish here would first overwrite the dashboard with the bare
          // answer on every platform.
          if (runState.completedSubagentProgress.length > 0) return;
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
