import type {
  ChatMessage,
  ChatResponseContext,
  ChatToolResult,
  PlatformInfo,
} from "../../adapter.js";
import * as log from "../../log.js";
import { formatToolArgs, splitText } from "../shared.js";
import type { SlackBot, SlackEvent } from "./bot.js";
import { resolveSlackRootTs, resolveSlackSessionKey } from "./session.js";

export const SLACK_FORMATTING_GUIDE = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).`;

const MAX_MAIN_LENGTH = 35000; // Best-effort streaming cap; final responses use Slack error-driven fallback.
const MAX_THREAD_LENGTH = 20000;
const FALLBACK_MAIN_LENGTH = 3000;
const WORKING_INDICATOR = " ...";
const TRUNCATION_NOTE_INCREMENTAL =
  "\n\n_(message truncated, ask me to elaborate on specific parts)_";

const formatSlackContinuation = (partNum: number): string => `_(continued ${partNum})_`;

function isSlackMessageTs(ts: string | undefined): ts is string {
  return typeof ts === "string" && /^\d+\.\d+$/.test(ts);
}

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
  isSyntheticEvent?: boolean,
): {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
} {
  let messageTs: string | null = null;
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
  let updatePromise = Promise.resolve();

  const channelId = event.channel;
  const conversationId = event.conversationId;
  const user = slack.getUser(event.user);

  // Synthetic event ts format: `event:<filename>`.
  const eventFilename = isSyntheticEvent
    ? event.ts.match(/^event:([^:]+(?:\.json)?)/)?.[1]
    : undefined;

  const rootTs =
    event.thread_ts ?? (isSlackMessageTs(event.ts) ? resolveSlackRootTs(event.ts) : undefined);
  const isThreaded = !!event.thread_ts;

  /**
   * Post the first visible reply.
   * Default Slack behavior is now top-level channel replies.
   * If the triggering message is already inside a thread, stay in that thread.
   * Synthetic event messages have no real Slack root ts, so they must post top-level.
   */
  const postFirstMessage = async (text: string): Promise<string> => {
    if (isSyntheticEvent) {
      if (event.thread_ts) {
        return slack.postInThread(channelId, event.thread_ts, text);
      }
      return slack.postMessage(channelId, text);
    }
    if (isThreaded && rootTs) {
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
        const CONTEXT_TEXT_LIMIT = 3000;
        const blockText =
          part.length > CONTEXT_TEXT_LIMIT
            ? part.substring(0, CONTEXT_TEXT_LIMIT - 20) + "\n_(truncated)_"
            : part;
        const ts = await slack.postInThreadBlocks(channelId, threadAnchor, part, [
          { type: "context", elements: [{ type: "mrkdwn", text: blockText }] },
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
    sessionKey: isSyntheticEvent
      ? `${conversationId}:${event.ts}`
      : (event.sessionKey ?? resolveSlackSessionKey(conversationId, event.thread_ts)),
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

  const responseCtx = {
    respond: async (text: string) => {
      updatePromise = updatePromise.then(async () => {
        try {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

          const mainLimit = isWorking
            ? MAX_MAIN_LENGTH - WORKING_INDICATOR.length
            : MAX_MAIN_LENGTH;
          if (accumulatedText.length > mainLimit) {
            accumulatedText =
              accumulatedText.substring(0, mainLimit - TRUNCATION_NOTE_INCREMENTAL.length) +
              TRUNCATION_NOTE_INCREMENTAL;
          }

          const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;

          if (messageTs) {
            await slack.updateMessage(channelId, messageTs, displayText);
          } else if (isThreaded && rootTs) {
            // Reply within the user's thread
            messageTs = await slack.postInThread(channelId, rootTs, displayText);
          } else {
            messageTs = await postFirstMessage(displayText);
            if (isSyntheticEvent && !event.thread_ts && messageTs) {
              slack.aliasSyntheticEventThread(channelId, messageTs, event.ts);
            }
          }

          if (messageTs) {
            slack.logBotResponse(channelId, text, messageTs, isThreaded ? rootTs : undefined);
          }
        } catch (err) {
          log.logWarning("Slack respond error", err instanceof Error ? err.message : String(err));
        }
      });
      await updatePromise;
    },

    replaceResponse: async (text: string, options?: { createOverflowLink?: () => string }) => {
      updatePromise = updatePromise.then(async () => {
        try {
          // Lazy: only mint a token if Slack actually rejects the message.
          let overflowLink: string | undefined;
          const resolveOverflowLink = (): string | undefined => {
            if (overflowLink === undefined && options?.createOverflowLink) {
              overflowLink = options.createOverflowLink();
            }
            return overflowLink;
          };

          const postOrUpdate = async (body: string): Promise<void> => {
            if (messageTs) {
              await slack.updateMessage(channelId, messageTs, body);
              return;
            }
            if (isThreaded && rootTs) {
              messageTs = await slack.postInThread(channelId, rootTs, body);
              return;
            }
            messageTs = await postFirstMessage(body);
            if (isSyntheticEvent && !event.thread_ts && messageTs) {
              slack.aliasSyntheticEventThread(channelId, messageTs, event.ts);
            }
          };

          accumulatedText = text;
          const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;

          try {
            await postOrUpdate(displayText);
          } catch (err) {
            if (!isSlackMsgTooLong(err)) throw err;
            const link = resolveOverflowLink();
            const fallback = await postSlackTextWithFallback(
              async (body) => {
                await postOrUpdate(body);
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
        } catch (err) {
          log.logWarning(
            "Slack replaceResponse error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      updatePromise = updatePromise.then(async () => {
        try {
          await postDiagnosticDirect(text, options);
        } catch (err) {
          log.logWarning(
            "Slack respondDiagnostic error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responseCtx.respondDiagnostic(formatSlackToolResult(result));
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
      updatePromise = updatePromise.then(async () => {
        try {
          isWorking = working;
          if (messageTs) {
            const displayText = isWorking ? accumulatedText + WORKING_INDICATOR : accumulatedText;
            const updates: Promise<void>[] = [
              slack.updateMessage(channelId, messageTs, displayText),
            ];
            if (!working) {
              if (rootTs) {
                updates.push(
                  slack
                    .setAssistantStatus(channelId, rootTs, "")
                    .catch((err) => onAssistantStatusError("clear-on-idle", err)),
                );
              }
            }
            await Promise.all(updates);
          }
        } catch (err) {
          log.logWarning(
            "Slack setWorking error",
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await updatePromise;
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
