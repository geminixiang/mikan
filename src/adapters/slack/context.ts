import type {
  ChatMessage,
  ChatResponseBlockKit,
  ChatResponseContext,
  ChatToolResult,
  PlatformInfo,
} from "../../adapter.js";
import * as log from "../../log.js";
import {
  createChatResponseErrorReporter,
  formatToolArgs,
  splitText,
  type ChatResponseErrorOperation,
} from "../shared.js";
import { BufferedResponseStream } from "../streaming.js";
import { buildMrkdwnContextBlock, type SlackBot, type SlackEvent } from "./bot.js";
import { planSlackAdapterSession } from "./session.js";
export type { SlackAdapterOptions } from "./types.js";
import type { SlackAdapterOptions } from "./types.js";

const SLACK_FORMATTING_GUIDE = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).`;

const MAX_MAIN_LENGTH = 35000; // Best-effort streaming cap; final responses use Slack error-driven fallback.
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

export function createSlackAdapters(
  event: SlackEvent,
  slack: SlackBot,
  adapterOptions: SlackAdapterOptions = {},
): {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
} {
  const sessionPlan = planSlackAdapterSession(event, {
    initialMessageTs: adapterOptions.initialMessageTs,
  });
  let messageTs: string | null = sessionPlan.initialMessageTs ?? null;
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
  let blockKitFinalized = false;
  let streamActive = false;
  let streamUnavailable = false;
  let streamedText = "";
  let updatePromise = Promise.resolve();

  const channelId = event.channel;
  const conversationId = event.conversationId;
  const user = slack.getUser(event.user);

  // Slack message timestamps are numeric; event-file triggers use `event:<filename>`.
  const eventFilename = event.ts.match(/^event:([^:]+(?:\.json)?)/)?.[1];

  const { rootTs, isThreaded } = sessionPlan;
  const replyMode = adapterOptions.replyMode ?? "top-level";
  const replyInThread = Boolean(rootTs && (isThreaded || replyMode === "thread"));

  /**
   * Post the first visible reply.
   * Default Slack behavior is now top-level channel replies.
   * If the triggering message is already inside a thread, stay in that thread.
   */
  const postFirstMessage = async (text: string): Promise<string> => {
    if (replyInThread && rootTs) {
      return slack.postInThread(channelId, rootTs, text);
    }
    return slack.postMessage(channelId, text);
  };

  const postDiagnosticDirect = async (
    text: string,
    options?: { style?: "muted" | "error" },
  ): Promise<void> => {
    const threadAnchor = messageTs ?? rootTs;
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

  const message: ChatMessage = {
    id: event.ts,
    sessionKey: sessionPlan.sessionKey,
    conversationKind: event.conversationKind,
    userId: event.user,
    userName: user?.userName,
    text: event.text,
    attachments: (event.attachments || []).map((a) => ({
      name: a.original,
      localPath: a.localPath,
    })),
    threadTs: event.thread_ts,
  };

  const platform: PlatformInfo = {
    name: "slack",
    formattingGuide: SLACK_FORMATTING_GUIDE,
    channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
    users: slack
      .getAllUsers()
      .map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
    diagnostics: {
      showUsageSummary: true,
    },
  };

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "slack",
    conversationId,
    channelId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: messageTs,
    threadTs: rootTs,
    conversationKind: message.conversationKind,
    isThreaded,
  }));

  const postOrUpdateMain = async (body: string, handleMsgTooLong = true): Promise<void> => {
    const writeMain = async (text: string): Promise<string | void> => {
      if (messageTs) {
        await slack.updateMessage(channelId, messageTs, text);
        return;
      }
      if (replyInThread && rootTs) {
        messageTs = await slack.postInThread(channelId, rootTs, text);
        return messageTs;
      }
      messageTs = await postFirstMessage(text);
      return messageTs;
    };

    try {
      await writeMain(body);
    } catch (err) {
      if (!handleMsgTooLong || !isSlackMsgTooLong(err)) throw err;
      const fallback = await postSlackTextWithFallback(writeMain, body);
      accumulatedText = fallback.text;
      stream.setText(accumulatedText);
    }
  };

  const abandonActiveStream = async (): Promise<void> => {
    if (!streamActive || !messageTs) return;
    const failedStreamTs = messageTs;
    streamActive = false;
    streamedText = "";
    await slack.stopMessageStream(channelId, failedStreamTs).catch(() => undefined);
    if (messageTs === failedStreamTs) messageTs = null;
  };

  const startOrAppendStream = async (text: string, displayText: string): Promise<void> => {
    if (streamUnavailable) {
      await postOrUpdateMain(displayText);
      return;
    }

    try {
      if (messageTs && streamActive) {
        if (!text.startsWith(streamedText)) {
          await abandonActiveStream();
          await postOrUpdateMain(displayText);
          return;
        }
        const delta = text.slice(streamedText.length);
        if (delta) {
          await slack.appendMessageStream(channelId, messageTs, delta);
          streamedText = text;
        }
        return;
      }
      if (!replyInThread || !rootTs) {
        streamUnavailable = true;
        await postOrUpdateMain(displayText);
        return;
      }
      messageTs = await slack.startMessageStream(channelId, text, rootTs);
      streamActive = true;
      streamedText = text;
    } catch (err) {
      streamUnavailable = true;
      log.logWarning(
        "Slack streaming unavailable; falling back to chat.update",
        err instanceof Error ? err.message : String(err),
      );
      await abandonActiveStream();
      await postOrUpdateMain(displayText);
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
      const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;
      await startOrAppendStream(text, displayText);
    },
    finish: async (text) => {
      accumulatedText = text;
      isWorking = false;
      if (streamActive && messageTs) {
        try {
          if (!accumulatedText.startsWith(streamedText)) {
            await abandonActiveStream();
            await postOrUpdateMain(accumulatedText);
            return;
          }
          const delta = accumulatedText.slice(streamedText.length);
          if (delta) {
            await slack.appendMessageStream(channelId, messageTs, delta);
            streamedText = accumulatedText;
          }
          await slack.stopMessageStream(channelId, messageTs);
          streamActive = false;
          streamedText = "";
          return;
        } catch (err) {
          streamUnavailable = true;
          log.logWarning(
            "Slack streaming unavailable; falling back to chat.update",
            err instanceof Error ? err.message : String(err),
          );
          await abandonActiveStream();
        }
      }
      if (messageTs || accumulatedText) {
        await postOrUpdateMain(accumulatedText);
      }
    },
  });

  const queueResponseOperation = async (
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    context: (err: unknown) => Record<string, unknown>,
  ): Promise<void> => {
    updatePromise = updatePromise.then(async () => {
      try {
        await work();
      } catch (err) {
        log.logWarning(`Slack ${label} error`, err instanceof Error ? err.message : String(err));
        reportResponseError(err, operation, context(err));
      }
    });
    await updatePromise;
  };

  const responseCtx = {
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
          const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;
          await startOrAppendStream(text, displayText);

          if (messageTs) {
            slack.logBotResponse(channelId, text, messageTs, replyInThread ? rootTs : undefined);
          }
        },
        () => ({
          phase: messageTs ? "update" : "initial_post",
          textLength: text.length,
          accumulatedLength: accumulatedText.length,
        }),
      );
    },

    appendResponseDelta: async (delta: string) => {
      await queueResponseOperation(
        "appendResponseDelta",
        "respond",
        async () => {
          await stream.append(delta);
          if (messageTs) {
            slack.logBotResponse(channelId, delta, messageTs, replyInThread ? rootTs : undefined);
          }
        },
        () => ({ textLength: delta.length, accumulatedLength: stream.getText().length }),
      );
    },

    finishResponse: async (finalText?: string) => {
      await queueResponseOperation(
        "finishResponse",
        "set_working",
        async () => {
          await stream.finish(finalText);
          accumulatedText = stream.getText();
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
          const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;

          try {
            if (streamActive && messageTs) {
              await slack.stopMessageStream(channelId, messageTs);
              streamActive = false;
              streamedText = "";
            }
            await postOrUpdateMain(displayText, false);
          } catch (err) {
            if (!isSlackMsgTooLong(err)) throw err;
            const link = resolveOverflowLink();
            const fallback = await postSlackTextWithFallback(
              async (body) => {
                await postOrUpdateMain(body);
              },
              text,
              link,
            );
            accumulatedText = fallback.text;
            const continuation = text.slice(fallback.prefixLength).trimStart();
            if (continuation) {
              await postDiagnosticDirect(`_(continued from truncated message)_\n\n${continuation}`);
            }
          }
        },
        () => ({
          textLength: text.length,
          hadExistingResponse: Boolean(messageTs),
        }),
      );
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
      await responseCtx.respondDiagnostic(formatSlackToolResult(result));
    },

    respondBlockKit: async (response: ChatResponseBlockKit) => {
      updatePromise = updatePromise.then(async () => {
        isWorking = false;
        accumulatedText = response.text;
        if (replyInThread && rootTs) {
          messageTs = await slack.postInThreadBlocks(
            channelId,
            rootTs,
            response.text,
            response.blocks,
          );
        } else {
          messageTs = await slack.postBlocks(channelId, response.text, response.blocks);
        }
        blockKitFinalized = true;
        slack.logBotResponse(
          channelId,
          response.text,
          messageTs,
          replyInThread ? rootTs : undefined,
          response.blocks,
        );
      });
      await updatePromise;
    },

    setTyping: async (isTyping: boolean) => {
      if (isTyping && !messageTs && rootTs) {
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
      await slack.uploadFile(channelId, filePath, title, rootTs);
    },

    setWorking: async (working: boolean) => {
      await queueResponseOperation(
        "setWorking",
        "set_working",
        async () => {
          isWorking = working;
          if (blockKitFinalized) {
            if (!working && rootTs) {
              await slack
                .setAssistantStatus(channelId, rootTs, "")
                .catch((err) => onAssistantStatusError("clear-on-idle", err));
            }
            return;
          }
          if (messageTs) {
            const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;
            const updates: Promise<void>[] =
              streamActive && !isWorking
                ? [
                    slack.stopMessageStream(channelId, messageTs).then(() => {
                      streamActive = false;
                    }),
                  ]
                : [slack.updateMessage(channelId, messageTs, displayText)];
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
      updatePromise = updatePromise.then(async () => {
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
        if (messageTs) {
          await slack.deleteMessage(channelId, messageTs);
          messageTs = null;
        }
      });
      await updatePromise;
    },
  };

  return { message, responseCtx, platform };
}
