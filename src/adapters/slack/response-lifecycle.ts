import type { ConversationMessage, ConversationResponder, ChatToolResult } from "../../adapter.js";
import * as log from "../../log.js";
import { createProgressiveRenderer } from "../progressive-renderer.js";
import { formatToolArgs, splitText } from "../shared.js";
import { buildMrkdwnContextBlock, type SlackMessagingBot, type SlackEvent } from "./bot.js";
import { renderSlackBlocks } from "./blocks.js";
import type { SlackAdapterSessionPlan } from "./types.js";

const MAX_MAIN_LENGTH = 35000;
/**
 * Slack's own SDK buffers streamed output at this size before sending, for
 * exactly the reason we do: appends are rate-limited per call, so forwarding
 * every token spends the budget on latency nobody can perceive.
 */
const STREAM_MIN_DELTA_CHARS = 256;

const MAX_THREAD_LENGTH = 20000;
const FALLBACK_MAIN_LENGTH = 3000;
const WORKING_INDICATOR = " ...";
const TRUNCATION_NOTE_INCREMENTAL =
  "\n\n_(message truncated, ask me to elaborate on specific parts)_";
const formatSlackContinuation = (partNum: number): string => `_(continued ${partNum})_`;

function isSlackMsgTooLong(err: unknown): boolean {
  const data = (err as { data?: { error?: string } } | undefined)?.data;
  const message = err instanceof Error ? err.message : String(err);
  return data?.error === "msg_too_long" || message.includes("msg_too_long");
}

function fallbackLongSlackText(
  text: string,
  overflowLink?: string,
  prefixLength = FALLBACK_MAIN_LENGTH,
): string {
  const suffix = overflowLink
    ? `\n\n_(message too long for Slack; continued in thread; session view: <${overflowLink}|open>)_`
    : "\n\n_(message too long for Slack; continued in thread)_";
  return `${text.slice(0, prefixLength)}${suffix}`;
}

async function postSlackTextWithFallback(
  post: (text: string) => Promise<void>,
  text: string,
  overflowLink?: string,
): Promise<{ text: string; prefixLength: number }> {
  let prefixLength = FALLBACK_MAIN_LENGTH;
  for (;;) {
    const fallbackText = fallbackLongSlackText(text, overflowLink, prefixLength);
    try {
      await post(fallbackText);
      return { text: fallbackText, prefixLength };
    } catch (err) {
      if (!isSlackMsgTooLong(err)) throw err;
      if (prefixLength === 0) throw err;
      prefixLength = Math.max(0, Math.floor(prefixLength / 2));
    }
  }
}

function formatSlackToolResult(result: ChatToolResult): string {
  const argsFormatted = formatToolArgs(result.args);
  const duration = (result.durationMs / 1000).toFixed(1);
  let text = `*${result.isError ? "✗" : "✓"} ${result.toolName}*`;
  if (result.label) text += `: ${result.label}`;
  text += ` (${duration}s)\n`;
  if (argsFormatted) text += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
  text += `*Result:*\n\`\`\`\n${result.result}\n\`\`\``;
  return text;
}

function closeOpenFences(text: string): string {
  let openMarker: string | null = null;
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker === undefined) continue;
    if (openMarker === null) openMarker = marker;
    else if (marker[0] === openMarker[0] && marker.length >= openMarker.length) openMarker = null;
  }
  return openMarker ? `${text}\n${openMarker}` : text;
}

function needsCanonicalRender(text: string): boolean {
  return renderSlackBlocks(text).blocks.some((block) => block.type === "table");
}

export function createSlackResponseContext({
  event,
  slack,
  sessionPlan,
  replyMode,
  message,
}: {
  event: SlackEvent;
  slack: SlackMessagingBot;
  sessionPlan: SlackAdapterSessionPlan;
  replyMode: "top-level" | "thread";
  message: ConversationMessage;
}): ConversationResponder {
  const channelId = event.channel;
  const conversationId = event.conversationId;
  const eventFilename = event.ts.match(/^event:([^:]+(?:\.json)?)/)?.[1];
  const { rootTs, isThreaded } = sessionPlan;
  const replyInThread = Boolean(rootTs && (isThreaded || replyMode === "thread"));
  let assistantStatusFailureWarned = false;
  /** How much of an over-long response the thread continuation already holds. */
  let continuationSent = "";

  const onAssistantStatusError = (label: string, err: unknown): void => {
    if (assistantStatusFailureWarned) return;
    assistantStatusFailureWarned = true;
    log.logWarning(
      `Slack setAssistantStatus failed (${label}; further occurrences suppressed for this session)`,
      err instanceof Error ? err.message : String(err),
    );
  };

  const postThreadDiagnostic = async (
    text: string,
    options: { style?: "muted" | "error" } = {},
    responseId: string | null,
  ): Promise<Array<string | number>> => {
    const threadAnchor = responseId ?? rootTs;
    if (!threadAnchor) return [];
    const ids: string[] = [];
    for (const part of splitText(text, MAX_THREAD_LENGTH, formatSlackContinuation)) {
      if (options.style === "muted") {
        ids.push(
          await slack.postInThreadBlocks(channelId, threadAnchor, part, [
            buildMrkdwnContextBlock(part),
          ]),
        );
      } else {
        ids.push(
          await slack.postInThread(
            channelId,
            threadAnchor,
            options.style === "error" ? `_${part}_` : part,
          ),
        );
      }
    }
    return ids;
  };

  // Reserve before choosing, not after failing: exceeding the start tier
  // costs a wasted request and a visibly worse first response, and the
  // buffered path is a working answer rather than a degraded one.
  const streamKind =
    replyInThread && rootTs && slack.tryReserveStreamStart() ? "native" : "buffered";
  const { responder } = createProgressiveRenderer({
    label: "Slack",
    maxLength: MAX_MAIN_LENGTH,
    initialResponseId: sessionPlan.initialMessageTs ?? null,
    formatContinuation: formatSlackContinuation,
    errorPrefix: "",
    workingIndicator: streamKind === "buffered" ? WORKING_INDICATOR : undefined,
    formatProvisional: (text, working) => {
      const closed = closeOpenFences(text);
      return working ? `${closed}${WORKING_INDICATOR}` : closed;
    },
    prepareSource: (text, working) => {
      const limit = working ? MAX_MAIN_LENGTH - WORKING_INDICATOR.length : MAX_MAIN_LENGTH;
      if (text.length <= limit) return text;
      return `${text.slice(0, Math.max(0, limit - TRUNCATION_NOTE_INCREMENTAL.length))}${TRUNCATION_NOTE_INCREMENTAL}`;
    },
    supportsDeltas: true,
    stream:
      streamKind === "native"
        ? {
            start: (text) => slack.startMessageStream(channelId, text, rootTs, event.user),
            append: (id, delta) => slack.appendMessageStream(channelId, id, delta),
            stop: (id) => slack.stopMessageStream(channelId, id),
            minDeltaChars: STREAM_MIN_DELTA_CHARS,
          }
        : undefined,
    needsCanonicalRender,
    formatToolResult: formatSlackToolResult,
    responseErrorContext: (responseId) => ({
      platform: "slack",
      conversationId,
      channelId,
      messageId: message.id,
      sessionKey: message.sessionKey,
      responseMessageId: responseId,
      threadTs: rootTs,
      conversationKind: message.conversationKind,
      isThreaded,
    }),
    post: (text) =>
      replyInThread && rootTs
        ? slack.postInThread(channelId, rootTs, text)
        : slack.postMessage(channelId, text),
    update: (id, text) => slack.updateMessage(channelId, id, text),
    postExtra: (text, responseId) =>
      slack.postInThread(channelId, responseId ?? rootTs ?? "", text),
    postDiagnostic: postThreadDiagnostic,
    delete: async (id) => {
      if (rootTs) {
        await slack
          .setAssistantStatus(channelId, rootTs, "")
          .catch((err) => onAssistantStatusError("clear-on-delete", err));
      }
      await slack.deleteMessage(channelId, id);
    },
    deleteExtra: (id) => slack.deleteMessage(channelId, String(id)),
    setTyping: async (isTyping, responseId) => {
      if (isTyping && !responseId && rootTs) {
        const statusText = eventFilename ? `Starting event: ${eventFilename}` : "Thinking";
        await slack
          .setAssistantStatus(channelId, rootTs, statusText)
          .catch((err) => onAssistantStatusError("typing", err));
      }
    },
    onWorkingChanged: async (working, responseId) => {
      if (!working && responseId && rootTs) {
        await slack
          .setAssistantStatus(channelId, rootTs, "")
          .catch((err) => onAssistantStatusError("clear-on-idle", err));
      }
    },
    onFinish: (text, responseId) => {
      if (responseId && text.trim()) {
        slack.logBotResponse(channelId, text, responseId, replyInThread ? rootTs : undefined);
      }
      if (rootTs) {
        void slack
          .setAssistantStatus(channelId, rootTs, "")
          .catch((err) => onAssistantStatusError("clear-on-idle", err));
      }
    },
    handleTooLong: async (text, operation, options, responseId, write, getResponseId) => {
      let overflowLink: string | undefined;
      const resolveOverflowLink = (): string | undefined => {
        if (overflowLink === undefined && options?.createOverflowLink) {
          overflowLink = options.createOverflowLink();
        }
        return overflowLink;
      };
      const fallback = await postSlackTextWithFallback(write, text, resolveOverflowLink());

      // The truncation notice promises a thread continuation unconditionally,
      // so every path that prints it has to deliver one. Gating delivery on
      // the final "replace" dropped the tail whenever a run ended on the
      // post-stream canonical render instead — silent data loss behind a
      // message that claimed the rest was elsewhere.
      //
      // Incremental renders call this repeatedly as the text grows, so send
      // only what the thread has not seen yet. Text normally grows by
      // appending; when it does not, the prefix check fails and we start the
      // thread over from the new truncation point rather than splicing two
      // unrelated bodies together.
      const continuation = text.slice(fallback.prefixLength).trimStart();
      if (continuation && continuation !== continuationSent) {
        const isExtension = continuation.startsWith(continuationSent);
        const unsent = isExtension ? continuation.slice(continuationSent.length) : continuation;
        if (unsent.trim()) {
          await postThreadDiagnostic(
            isExtension && continuationSent
              ? unsent
              : `_(continued from truncated message)_\n\n${unsent}`,
            {},
            replyInThread
              ? (rootTs ?? getResponseId() ?? responseId)
              : (getResponseId() ?? responseId),
          );
          continuationSent = continuation;
        }
      }
      return fallback;
    },
    uploadFile: (filePath, title) =>
      slack.uploadFile(channelId, filePath, title, replyInThread ? rootTs : undefined),
    react: async (emoji) => {
      if (!eventFilename) await slack.addReaction(channelId, event.ts, emoji);
    },
  });

  return responder;
}
