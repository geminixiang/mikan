import type {
  ConversationMessage,
  ConversationResponder,
  ChatToolResult,
  MessagingInfo,
} from "../../adapter.js";
import * as log from "../../log.js";
import { createChatResponseErrorReporter, formatToolArgs, splitText } from "../shared.js";
import { BufferedResponseStream, OrderedResponseOperations } from "../streaming.js";
import { deriveSessionKey } from "../../sessions/session-key.js";
import { sanitizeTelegramHtml } from "./html.js";
import type { TelegramMessagingBot, TelegramEvent } from "./bot.js";

// Telegram message length limit is 4096 chars; 3800 leaves headroom for HTML escapes.
const MAX_LENGTH = 3800;

const formatTelegramContinuation = (partNum: number): string => `(continued ${partNum})`;

async function notifyError(
  bot: TelegramMessagingBot,
  chatId: number,
  label: string,
  err: unknown,
  report?: () => void,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  log.logWarning(`Telegram ${label} error`, errMsg);
  report?.();
  try {
    await bot.postPlainMessage(chatId, `⚠️ 發送失敗：${errMsg}`);
  } catch {
    // ignore secondary failure
  }
}

function formatToolResult(result: ChatToolResult): string {
  const argsFormatted = formatToolArgs(result.args);
  const duration = (result.durationMs / 1000).toFixed(1);
  const title = `${result.isError ? "Error" : "Done"} ${result.toolName}${result.label ? `: ${result.label}` : ""} (${duration}s)`;
  return [title, argsFormatted, result.result].filter(Boolean).join("\n\n");
}

export function createTelegramAdapters(
  event: TelegramEvent,
  bot: TelegramMessagingBot,
): {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  let messageId: number | null = null;
  let accumulatedText = "";
  const responseOperations = new OrderedResponseOperations();
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let typingFailureWarned = false;

  function stopTyping() {
    if (typingInterval !== null) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  const conversationId = event.conversationId;
  const chatId = parseInt(conversationId);
  const replyToId = event.thread_ts ? parseInt(event.thread_ts) : null;

  const message: ConversationMessage = {
    id: event.ts,
    sessionKey: deriveSessionKey(event),
    conversationKind: event.conversationKind,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
  };

  // The bot's getMessagingInfo() is the single authority for platform info.
  const platform: MessagingInfo = bot.getMessagingInfo();

  async function sendContinuation(text: string): Promise<void> {
    await bot.postMessageRaw(chatId, text);
  }

  async function sendOrUpdate(displayText: string): Promise<void> {
    if (messageId !== null) {
      await bot.updateMessage(conversationId, String(messageId), displayText);
    } else if (replyToId !== null) {
      messageId = await bot.postReply(chatId, replyToId, displayText);
    } else {
      messageId = await bot.postMessageRaw(chatId, displayText);
    }
  }

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "telegram",
    conversationId,
    chatId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: messageId,
    replyToId,
    conversationKind: message.conversationKind,
  }));

  const sendSplitText = async (
    text: string,
    firstPart: (part: string) => Promise<void>,
  ): Promise<void> => {
    const [head, ...tail] = splitText(text, MAX_LENGTH, formatTelegramContinuation);
    await firstPart(head);
    for (const part of tail) {
      await sendContinuation(part);
    }
  };

  const stream = new BufferedResponseStream({
    flush: async (text) => {
      await sendSplitText(text, sendOrUpdate);
    },
    finish: async (text) => {
      stopTyping();
      await sendSplitText(text, sendOrUpdate);
    },
  });

  const queueTelegramSend = (
    label: string,
    work: () => Promise<void>,
    report: (err: unknown) => void,
  ): Promise<void> =>
    responseOperations.run(work, (err) => notifyError(bot, chatId, label, err, () => report(err)));

  const responder: ConversationResponder = {
    respond: async (text: string) => {
      await queueTelegramSend(
        "respond",
        async () => {
          const sanitized = sanitizeTelegramHtml(text);
          accumulatedText = accumulatedText ? `${accumulatedText}\n${sanitized}` : sanitized;
          stream.setText(accumulatedText);
          await sendSplitText(accumulatedText, sendOrUpdate);
          if (messageId !== null) {
            bot.logBotResponse(conversationId, text, String(messageId));
          }
        },
        (err) =>
          reportResponseError(err, "respond", {
            phase: messageId ? "update" : "initial_post",
            textLength: text.length,
            accumulatedLength: accumulatedText.length,
          }),
      );
    },

    appendResponseDelta: async (delta: string) => {
      await queueTelegramSend(
        "appendResponseDelta",
        async () => {
          const sanitized = sanitizeTelegramHtml(delta);
          await stream.append(sanitized);
          accumulatedText = stream.getText();
          if (messageId !== null) {
            bot.logBotResponse(conversationId, delta, String(messageId));
          }
        },
        (err) =>
          reportResponseError(err, "respond", {
            textLength: delta.length,
            accumulatedLength: stream.getText().length,
          }),
      );
    },

    finishResponse: async (finalText?: string) => {
      await queueTelegramSend(
        "finishResponse",
        async () => {
          await stream.finish(
            finalText === undefined ? undefined : sanitizeTelegramHtml(finalText),
          );
          accumulatedText = stream.getText();
        },
        (err) =>
          reportResponseError(err, "set_working", {
            finalTextLength: finalText?.length,
          }),
      );
    },

    replaceResponse: async (text: string) => {
      await queueTelegramSend(
        "replaceResponse",
        async () => {
          accumulatedText = sanitizeTelegramHtml(text);
          stream.setText(accumulatedText);
          await sendSplitText(accumulatedText, sendOrUpdate);
        },
        (err) =>
          reportResponseError(err, "replace_response", {
            textLength: text.length,
            hadExistingResponse: Boolean(messageId),
          }),
      );
    },

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      await queueTelegramSend(
        "respondDiagnostic",
        async () => {
          const prefix = options?.style === "error" ? "Error: " : "";
          await sendSplitText(sanitizeTelegramHtml(`${prefix}${text}`), sendContinuation);
        },
        (err) =>
          reportResponseError(err, "respond_diagnostic", {
            textLength: text.length,
            style: options?.style,
          }),
      );
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responder.respondDiagnostic(formatToolResult(result));
    },

    setTyping: async (isTyping: boolean) => {
      const onTypingError = (err: unknown): void => {
        if (typingFailureWarned) return;
        typingFailureWarned = true;
        log.logWarning(
          "Telegram sendTyping failed (further occurrences suppressed for this session)",
          err instanceof Error ? err.message : String(err),
        );
      };
      if (isTyping && typingInterval === null) {
        // Send immediately and repeat every 4s (Telegram clears indicator after ~5s)
        bot.sendTyping(chatId).catch(onTypingError);
        typingInterval = setInterval(() => {
          bot.sendTyping(chatId).catch(onTypingError);
        }, 4000);
      } else if (!isTyping) {
        stopTyping();
      }
    },

    setWorking: async (working: boolean) => {
      if (!working) stopTyping();
    },

    uploadFile: async (filePath: string, title?: string) => {
      await bot.uploadFile(conversationId, filePath, title);
    },

    deleteResponse: async () => {
      await responseOperations.run(async () => {
        if (messageId !== null) {
          try {
            await bot.deleteMessageRaw(chatId, messageId);
          } catch {
            // Ignore errors
          }
          messageId = null;
        }
      });
    },
  };

  return { message, responder, platform };
}
