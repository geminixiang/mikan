import type {
  ConversationMessage,
  ConversationResponder,
  ChatToolResult,
  SubagentProgressSnapshot,
} from "../../adapter.js";
import * as log from "../../log.js";
import {
  createChatResponseErrorReporter,
  formatToolArgs,
  splitText,
  type ChatResponseErrorOperation,
} from "../shared.js";
import { BufferedResponseStream, OrderedResponseOperations } from "../streaming.js";
import { renderSubagentDashboard } from "../../subagent-progress.js";
import { buildMrkdwnContextBlock, type SlackMessagingBot, type SlackEvent } from "./bot.js";
import { SlackProgressiveRender, WORKING_INDICATOR } from "./progressive-render.js";
import type { SlackAdapterSessionPlan } from "./types.js";

const MAX_MAIN_LENGTH = 35000; // Best-effort streaming cap; final responses use Slack error-driven fallback.
const MAX_THREAD_LENGTH = 20000;
const FALLBACK_MAIN_LENGTH = 3000;
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
  post: (text: string) => Promise<string | void>,
  text: string,
  overflowLink?: string,
): Promise<{ result: string | void; text: string; prefixLength: number }> {
  let prefixLength = FALLBACK_MAIN_LENGTH;
  let lastErr: unknown;

  for (;;) {
    const fallbackText = fallbackLongSlackText(text, overflowLink, prefixLength);
    try {
      const result = await post(fallbackText);
      return { result, text: fallbackText, prefixLength };
    } catch (err) {
      if (!isSlackMsgTooLong(err)) throw err;
      lastErr = err;
      if (prefixLength === 0) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      }
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
  let assistantStatusFailureWarned = false;
  const onAssistantStatusError = (label: string, err: unknown): void => {
    if (assistantStatusFailureWarned) return;
    assistantStatusFailureWarned = true;
    log.logWarning(
      `Slack setAssistantStatus failed (${label}; further occurrences suppressed for this session)`,
      err instanceof Error ? err.message : String(err),
    );
  };
  const threadMessageTs: string[] = [];
  let accumulatedText = "";
  let isWorking = true;
  let mainResponseLogged = false;
  let resetStreamOnNextDelta = false;
  let subagentDashboardActive = false;
  const responseOperations = new OrderedResponseOperations();

  const channelId = event.channel;
  const conversationId = event.conversationId;

  // Slack message timestamps are numeric; event-file triggers use `event:<filename>`.
  const eventFilename = event.ts.match(/^event:([^:]+(?:\.json)?)/)?.[1];

  const { rootTs, isThreaded } = sessionPlan;
  const replyInThread = Boolean(rootTs && (isThreaded || replyMode === "thread"));

  /**
   * The progressive renderer owns the response message: whether it renders via
   * native markdown_text streaming (thread replies) or markdown-block updates,
   * and the switch between them. Default Slack behavior is top-level channel
   * replies; if the triggering message is already inside a thread, stay there.
   */
  const progressive = new SlackProgressiveRender(slack, {
    channelId,
    rootTs,
    replyInThread,
    recipientUserId: event.user,
    initialMessageTs: sessionPlan.initialMessageTs ?? null,
  });

  const postDiagnosticDirect = async (
    text: string,
    options?: { style?: "muted" | "error" },
    anchorTs?: string,
  ): Promise<void> => {
    const threadAnchor = anchorTs ?? progressive.messageTs ?? rootTs;
    if (!threadAnchor) return;

    for (const part of splitText(text, MAX_THREAD_LENGTH, formatSlackContinuation)) {
      if (options?.style === "muted") {
        const ts = await slack.postInThreadBlocks(channelId, threadAnchor, part, [
          buildMrkdwnContextBlock(part),
        ]);
        threadMessageTs.push(ts);
      } else {
        const diagnosticText = options?.style === "error" ? `_${part}_` : part;
        const ts = await slack.postInThread(channelId, threadAnchor, diagnosticText);
        threadMessageTs.push(ts);
      }
    }
  };

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "slack",
    conversationId,
    channelId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: progressive.messageTs,
    threadTs: rootTs,
    conversationKind: message.conversationKind,
    isThreaded,
  }));

  /** Run a progressive render, downgrading msg_too_long to the truncation
   *  fallback (halving prefix + overflow note) via the renderer's raw write. */
  const renderWithTooLongFallback = async (render: () => Promise<void>): Promise<void> => {
    try {
      await render();
    } catch (err) {
      if (!isSlackMsgTooLong(err)) throw err;
      const fallback = await postSlackTextWithFallback(
        (text) => progressive.write(text),
        accumulatedText,
      );
      accumulatedText = fallback.text;
      stream.setText(accumulatedText);
    }
  };

  const stream = new BufferedResponseStream({
    flush: async (text) => {
      accumulatedText = text;
      const mainLimit = isWorking ? MAX_MAIN_LENGTH - WORKING_INDICATOR.length : MAX_MAIN_LENGTH;
      if (accumulatedText.length > mainLimit) {
        accumulatedText =
          accumulatedText.substring(0, mainLimit - TRUNCATION_NOTE_INCREMENTAL.length) +
          TRUNCATION_NOTE_INCREMENTAL;
        stream.setText(accumulatedText);
      }
      await renderWithTooLongFallback(() => progressive.delta(accumulatedText, isWorking));
    },
    finish: async (text) => {
      accumulatedText = text;
      isWorking = false;
      await renderWithTooLongFallback(() => progressive.finish(accumulatedText));
    },
  });

  const queueResponseOperation = (
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    context: (err: unknown) => Record<string, unknown>,
  ): Promise<void> =>
    responseOperations.run(work, (err) => {
      log.logWarning(`Slack ${label} error`, err instanceof Error ? err.message : String(err));
      reportResponseError(err, operation, context(err));
    });

  const responder: ConversationResponder = {
    respond: async (text: string) => {
      await queueResponseOperation(
        "respond",
        "respond",
        async () => {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

          const mainLimit = isWorking
            ? MAX_MAIN_LENGTH - WORKING_INDICATOR.length
            : MAX_MAIN_LENGTH;
          if (accumulatedText.length > mainLimit) {
            accumulatedText =
              accumulatedText.substring(0, mainLimit - TRUNCATION_NOTE_INCREMENTAL.length) +
              TRUNCATION_NOTE_INCREMENTAL;
          }

          stream.setText(accumulatedText);
          await renderWithTooLongFallback(() => progressive.delta(accumulatedText, isWorking));
        },
        () => ({
          phase: progressive.messageTs ? "update" : "initial_post",
          textLength: text.length,
          accumulatedLength: accumulatedText.length,
        }),
      );
    },

    appendResponseDelta: async (delta: string) => {
      if (subagentDashboardActive) return;
      await queueResponseOperation(
        "appendResponseDelta",
        "respond",
        async () => {
          if (resetStreamOnNextDelta) {
            stream.setText("");
            resetStreamOnNextDelta = false;
          }
          await stream.append(delta);
        },
        () => ({ textLength: delta.length, accumulatedLength: stream.getText().length }),
      );
    },

    finishResponse: async (finalText?: string) => {
      if (subagentDashboardActive) return;
      if (resetStreamOnNextDelta) {
        if (finalText !== undefined) stream.setText(finalText);
        return;
      }
      await queueResponseOperation(
        "finishResponse",
        "set_working",
        async () => {
          await stream.finish(finalText);
          accumulatedText = stream.getText();
          if (progressive.messageTs && accumulatedText.trim() && !mainResponseLogged) {
            slack.logBotResponse(
              channelId,
              accumulatedText,
              progressive.messageTs,
              replyInThread ? rootTs : undefined,
            );
            mainResponseLogged = true;
          }
          if (!rootTs) return;
          await slack
            .setAssistantStatus(channelId, rootTs, "")
            .catch((err) => onAssistantStatusError("clear-on-idle", err));
        },
        () => ({ finalTextLength: finalText?.length }),
      );
    },

    replaceResponse: async (text: string, options?: { createOverflowLink?: () => string }) => {
      await queueResponseOperation(
        "replaceResponse",
        "replace_response",
        async () => {
          // Lazy: only mint a token if Slack actually rejects the message.
          let overflowLink: string | undefined;
          const resolveOverflowLink = (): string | undefined => {
            if (overflowLink === undefined && options?.createOverflowLink) {
              overflowLink = options.createOverflowLink();
            }
            return overflowLink;
          };

          accumulatedText = text;
          stream.setText(accumulatedText);
          resetStreamOnNextDelta = true;

          try {
            await progressive.replace(accumulatedText, isWorking);
          } catch (err) {
            if (!isSlackMsgTooLong(err)) throw err;
            const link = resolveOverflowLink();
            const fallback = await postSlackTextWithFallback(
              (body) => progressive.write(body),
              text,
              link,
            );
            accumulatedText = fallback.text;
            const continuation = text.slice(fallback.prefixLength).trimStart();
            if (continuation) {
              await postDiagnosticDirect(
                `_(continued from truncated message)_\n\n${continuation}`,
                undefined,
                replyInThread ? rootTs : (progressive.messageTs ?? rootTs),
              );
            }
          }
        },
        () => ({
          textLength: text.length,
          hadExistingResponse: Boolean(progressive.messageTs),
        }),
      );
    },

    replaceSubagentProgress: async (progress: SubagentProgressSnapshot, finalText?: string) => {
      subagentDashboardActive = true;
      // The dashboard is response source: renderSlackBlocks converts the
      // Markdown natively, the same as every other response (ADR-0001).
      const dashboard = renderSubagentDashboard(progress);
      await responder.replaceResponse(finalText ? `${dashboard}\n\n${finalText}` : dashboard);
    },

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      await queueResponseOperation(
        "respondDiagnostic",
        "respond_diagnostic",
        async () => {
          await postDiagnosticDirect(text, options);
        },
        () => ({
          textLength: text.length,
          style: options?.style,
        }),
      );
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responder.respondDiagnostic(formatSlackToolResult(result));
    },

    setTyping: async (isTyping: boolean) => {
      if (isTyping && !progressive.messageTs && rootTs) {
        try {
          const statusText = eventFilename ? `Starting event: ${eventFilename}` : "Thinking";
          await slack.setAssistantStatus(channelId, rootTs, statusText);
        } catch (err) {
          // Assistant API not available — first respond() call will create the message.
          onAssistantStatusError("typing", err);
        }
      }
    },

    uploadFile: async (filePath: string, title?: string) => {
      await slack.uploadFile(channelId, filePath, title, replyInThread ? rootTs : undefined);
    },

    react: async (emoji: string) => {
      // React to the triggering message. Event runs have no real message ts.
      if (eventFilename) return;
      await slack.addReaction(channelId, event.ts, emoji);
    },

    setWorking: async (working: boolean) => {
      await queueResponseOperation(
        "setWorking",
        "set_working",
        async () => {
          isWorking = working;
          if (progressive.messageTs) {
            const updates: Promise<void>[] = [progressive.setWorking(accumulatedText, working)];
            if (!working && rootTs) {
              updates.push(
                slack
                  .setAssistantStatus(channelId, rootTs, "")
                  .catch((err) => onAssistantStatusError("clear-on-idle", err)),
              );
            }
            await Promise.all(updates);
          }
        },
        () => ({ working }),
      );
    },

    deleteResponse: async () => {
      await responseOperations.run(async () => {
        // Clear assistant status first
        if (rootTs) {
          try {
            await slack.setAssistantStatus(channelId, rootTs, "");
          } catch {
            // Ignore errors clearing status
          }
        }

        // Delete thread messages first (in reverse order)
        for (let i = threadMessageTs.length - 1; i >= 0; i--) {
          try {
            await slack.deleteMessage(channelId, threadMessageTs[i]);
          } catch {
            // Ignore errors deleting thread messages
          }
        }
        threadMessageTs.length = 0;
        // Then delete main message
        if (progressive.messageTs) {
          await slack.deleteMessage(channelId, progressive.messageTs);
          progressive.clearMessage();
        }
      });
    },
  };

  return responder;
}
