import type { ConversationMessage, ConversationResponder, ChatToolResult } from "../../adapter.js";
import * as log from "../../log.js";
import { createProgressiveRenderer } from "../progressive-renderer.js";
import { formatToolArgs, splitText } from "../shared.js";
import type { HandleTooLongInput } from "../types.js";
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

/**
 * Where to cut a response that has to be truncated.
 *
 * Back off to the last line break rather than slicing at the exact budget: a
 * hard cut lands mid-word, and since the notice is inserted between the two
 * halves, the line cannot be read whole in either place. Only back off within
 * reach of the limit — a response with no line break in its final quarter has
 * nothing better to offer, and losing a quarter of it would be worse.
 */
function truncationCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const lastBreak = text.lastIndexOf("\n", limit);
  return lastBreak > limit * 0.75 ? lastBreak : limit;
}

function fallbackLongSlackText(
  text: string,
  overflowLink?: string,
  prefixLength = FALLBACK_MAIN_LENGTH,
): { text: string; cut: number } {
  const suffix = overflowLink
    ? `\n\n_(message too long for Slack; continued in thread; session view: <${overflowLink}|open>)_`
    : "\n\n_(message too long for Slack; continued in thread)_";
  const cut = truncationCut(text, prefixLength);
  return { text: `${text.slice(0, cut)}${suffix}`, cut };
}

async function postSlackTextWithFallback(
  post: (text: string) => Promise<void>,
  text: string,
  overflowLink?: string,
): Promise<{ text: string; prefixLength: number }> {
  let prefixLength = FALLBACK_MAIN_LENGTH;
  for (;;) {
    const fallback = fallbackLongSlackText(text, overflowLink, prefixLength);
    try {
      await post(fallback.text);
      // The continuation resumes from where the text was actually cut, which
      // is not the nominal budget once it backs off to a line break.
      return { text: fallback.text, prefixLength: fallback.cut };
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

interface SlackResponseLifecycleOptions {
  event: SlackEvent;
  slack: SlackMessagingBot;
  sessionPlan: SlackAdapterSessionPlan;
  replyInThread: boolean;
  eventFilename: string | undefined;
}

class SlackResponseLifecycle {
  private assistantStatusFailureWarned = false;
  /** The tail of an over-long response, awaiting delivery to a thread. */
  private pendingContinuation = "";
  private continuationAnchor: string | null = null;
  /** How much of that tail the thread already holds. */
  private continuationSent = "";

  constructor(private readonly context: SlackResponseLifecycleOptions) {}

  private onAssistantStatusError(label: string, err: unknown): void {
    if (this.assistantStatusFailureWarned) return;
    this.assistantStatusFailureWarned = true;
    log.logWarning(
      `Slack setAssistantStatus failed (${label}; further occurrences suppressed for this session)`,
      err instanceof Error ? err.message : String(err),
    );
  }

  async postThreadDiagnostic(
    text: string,
    options: { style?: "muted" | "error" } = {},
    responseId: string | null,
  ): Promise<Array<string | number>> {
    const { event, sessionPlan, slack } = this.context;
    const threadAnchor = responseId ?? sessionPlan.rootTs;
    if (!threadAnchor) return [];
    const ids: string[] = [];
    for (const part of splitText(text, MAX_THREAD_LENGTH, formatSlackContinuation)) {
      if (options.style === "muted") {
        ids.push(
          await slack.postInThreadBlocks(event.channel, threadAnchor, part, [
            buildMrkdwnContextBlock(part),
          ]),
        );
      } else {
        ids.push(
          await slack.postInThread(
            event.channel,
            threadAnchor,
            options.style === "error" ? `_${part}_` : part,
          ),
        );
      }
    }
    return ids;
  }

  /**
   * Deliver the tail of an over-long response to its thread.
   *
   * Called only at points where the response is final, and idempotent, so the
   * replace path and the end of the run can both call it without the thread
   * seeing anything twice. Sending the whole remainder in one message is also
   * what keeps it faithful: Slack trims message text, so every extra split is
   * a chance to drop the whitespace it lands on.
   */
  private async flushContinuation(): Promise<void> {
    if (!this.pendingContinuation || this.pendingContinuation === this.continuationSent) return;
    const extendsSentPrefix = this.pendingContinuation.startsWith(this.continuationSent);
    const unsent = extendsSentPrefix
      ? this.pendingContinuation.slice(this.continuationSent.length)
      : this.pendingContinuation;
    if (!unsent.trim()) return;
    await this.postThreadDiagnostic(
      extendsSentPrefix && this.continuationSent
        ? unsent
        : `_(continued from truncated message)_\n\n${unsent}`,
      {},
      this.continuationAnchor,
    );
    this.continuationSent = this.pendingContinuation;
  }

  async deleteMessage(id: string): Promise<void> {
    const { event, sessionPlan, slack } = this.context;
    if (sessionPlan.rootTs) {
      await slack
        .setAssistantStatus(event.channel, sessionPlan.rootTs, "")
        .catch((err) => this.onAssistantStatusError("clear-on-delete", err));
    }
    await slack.deleteMessage(event.channel, id);
  }

  async setTyping(isTyping: boolean, responseId: string | null): Promise<void> {
    const { event, eventFilename, sessionPlan, slack } = this.context;
    if (!isTyping || responseId || !sessionPlan.rootTs) return;
    const statusText = eventFilename ? `Starting event: ${eventFilename}` : "Thinking";
    await slack
      .setAssistantStatus(event.channel, sessionPlan.rootTs, statusText)
      .catch((err) => this.onAssistantStatusError("typing", err));
  }

  async onWorkingChanged(working: boolean, responseId: string | null): Promise<void> {
    const { event, sessionPlan, slack } = this.context;
    if (working || !responseId || !sessionPlan.rootTs) return;
    await slack
      .setAssistantStatus(event.channel, sessionPlan.rootTs, "")
      .catch((err) => this.onAssistantStatusError("clear-on-idle", err));
  }

  async onFinish(text: string, responseId: string | null): Promise<void> {
    const { event, replyInThread, sessionPlan, slack } = this.context;
    if (responseId && text.trim()) {
      slack.logBotResponse(
        event.channel,
        text,
        responseId,
        replyInThread ? sessionPlan.rootTs : undefined,
      );
    }
    if (sessionPlan.rootTs) {
      void slack
        .setAssistantStatus(event.channel, sessionPlan.rootTs, "")
        .catch((err) => this.onAssistantStatusError("clear-on-idle", err));
    }
    await this.flushContinuation();
  }

  async handleTooLong({
    text,
    operation,
    options,
    responseId,
    write,
    getResponseId,
  }: HandleTooLongInput): Promise<{ text: string; prefixLength: number }> {
    const { replyInThread, sessionPlan } = this.context;
    let overflowLink: string | undefined;
    const resolveOverflowLink = (): string | undefined => {
      if (overflowLink === undefined && options?.createOverflowLink) {
        overflowLink = options.createOverflowLink();
      }
      return overflowLink;
    };
    const fallback = await postSlackTextWithFallback(write, text, resolveOverflowLink());

    // The truncation notice promises a thread continuation unconditionally,
    // so every path that prints it has to deliver one. Incremental renders
    // reach this repeatedly as the text grows, so the tail is only recorded
    // here and delivered once the response is final. Posting each increment
    // would also lose whitespace that Slack trims at fragment boundaries.
    this.pendingContinuation = text.slice(fallback.prefixLength).trimStart();
    this.continuationAnchor = replyInThread
      ? (sessionPlan.rootTs ?? getResponseId() ?? responseId)
      : (getResponseId() ?? responseId);
    if (operation === "replace") await this.flushContinuation();
    return fallback;
  }
}

function formatProvisionalSlackText(text: string, working: boolean): string {
  const closed = closeOpenFences(text);
  return working ? `${closed}${WORKING_INDICATOR}` : closed;
}

function prepareSlackSource(text: string, working: boolean): string {
  const limit = working ? MAX_MAIN_LENGTH - WORKING_INDICATOR.length : MAX_MAIN_LENGTH;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - TRUNCATION_NOTE_INCREMENTAL.length))}${TRUNCATION_NOTE_INCREMENTAL}`;
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
  const { rootTs, isThreaded } = sessionPlan;
  const replyInThread = Boolean(rootTs && (isThreaded || replyMode === "thread"));
  const eventFilename = event.ts.match(/^event:([^:]+(?:\.json)?)/)?.[1];
  const lifecycle = new SlackResponseLifecycle({
    event,
    slack,
    sessionPlan,
    replyInThread,
    eventFilename,
  });

  // Reserve before choosing, not after failing: the buffered path is a
  // working answer rather than a degraded retry after a wasted request.
  const streamKind =
    replyInThread && rootTs && slack.tryReserveStreamStart() ? "native" : "buffered";
  const { responder } = createProgressiveRenderer({
    label: "Slack",
    maxLength: MAX_MAIN_LENGTH,
    initialResponseId: sessionPlan.initialMessageTs ?? null,
    formatContinuation: formatSlackContinuation,
    errorPrefix: "",
    workingIndicator: streamKind === "buffered" ? WORKING_INDICATOR : undefined,
    formatProvisional: formatProvisionalSlackText,
    prepareSource: prepareSlackSource,
    supportsDeltas: true,
    stream:
      streamKind === "native"
        ? {
            start: (text) => slack.startMessageStream(event.channel, text, rootTs, event.user),
            append: (id, delta) => slack.appendMessageStream(event.channel, id, delta),
            stop: (id) => slack.stopMessageStream(event.channel, id),
            minDeltaChars: STREAM_MIN_DELTA_CHARS,
          }
        : undefined,
    needsCanonicalRender,
    formatToolResult: formatSlackToolResult,
    responseErrorContext: (responseId) => ({
      platform: "slack",
      conversationId: event.conversationId,
      channelId: event.channel,
      messageId: message.id,
      sessionKey: message.sessionKey,
      responseMessageId: responseId,
      threadTs: rootTs,
      conversationKind: message.conversationKind,
      isThreaded,
    }),
    post: (text) =>
      replyInThread && rootTs
        ? slack.postInThread(event.channel, rootTs, text)
        : slack.postMessage(event.channel, text),
    update: (id, text) => slack.updateMessage(event.channel, id, text),
    postExtra: (text, responseId) =>
      slack.postInThread(event.channel, responseId ?? rootTs ?? "", text),
    postDiagnostic: lifecycle.postThreadDiagnostic.bind(lifecycle),
    delete: lifecycle.deleteMessage.bind(lifecycle),
    deleteExtra: (id) => slack.deleteMessage(event.channel, String(id)),
    setTyping: lifecycle.setTyping.bind(lifecycle),
    onWorkingChanged: lifecycle.onWorkingChanged.bind(lifecycle),
    onFinish: lifecycle.onFinish.bind(lifecycle),
    isTooLongError: isSlackMsgTooLong,
    handleTooLong: lifecycle.handleTooLong.bind(lifecycle),
    uploadFile: (filePath, title) =>
      slack.uploadFile(event.channel, filePath, title, replyInThread ? rootTs : undefined),
    react: async (emoji) => {
      if (!eventFilename) await slack.addReaction(event.channel, event.ts, emoji);
    },
  });

  return responder;
}
