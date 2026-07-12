import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConversationResponder, MessagingInfo } from "../adapter.js";
import type { MikanAgentSession } from "../harness/index.js";
import { resolveConversationSettings } from "../config.js";
import * as log from "../log.js";
import { metricAttributes, reportUserFacingError } from "../observability/sentry.js";
import * as Sentry from "@sentry/node";
import { appendTriggerAttribution } from "./prompt.js";

export interface RunnerSessionState {
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
  return (
    lastAssistant?.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n") || ""
  );
}

export function isEventTriggerAttribution(triggerAttribution: string | undefined): boolean {
  return triggerAttribution?.startsWith("[event:") === true;
}

export function extractToolLabel(toolName: string, args: unknown): string {
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

export function formatResponseWithToolProgress(text: string, runState: RunnerSessionState): string {
  const progress = formatToolProgress(runState);
  return progress ? `${progress}\n\n${text}` : text;
}

export async function replaceResponseWithToolProgress(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): Promise<void> {
  const progress = formatToolProgress(runState);
  if (progress) await responder.replaceResponse(progress);
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
  session: MikanAgentSession;
  runState: RunnerSessionState;
  responder: ConversationResponder;
  platform: MessagingInfo;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionConversation: string;
  sessionUuid: string;
  waitForQueue: () => Promise<void>;
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

export function extractToolResultText(result: unknown): string {
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
