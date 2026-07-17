import type {
  ChatToolResult,
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
} from "../../adapter.js";
import { deriveSessionKey } from "../../sessions/session-key.js";
import { createBufferedResponder } from "../buffered-responder.js";
import { createChatResponseErrorReporter, formatToolArgs } from "../shared.js";
import { sanitizeTelegramHtml } from "./html.js";
import type { TelegramMessagingBot, TelegramEvent } from "./bot.js";

// Telegram message length limit is 4096 chars; 3800 leaves headroom for HTML escapes.
const MAX_LENGTH = 3800;

const formatTelegramContinuation = (partNum: number): string => `(continued ${partNum})`;

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

  let currentResponseId: string | null = null;

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "telegram",
    conversationId,
    chatId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: currentResponseId,
    replyToId,
    conversationKind: message.conversationKind,
  }));

  const { responder } = createBufferedResponder({
    label: "Telegram",
    maxLength: MAX_LENGTH,
    formatContinuation: formatTelegramContinuation,
    errorPrefix: "Error: ",
    sanitize: sanitizeTelegramHtml,
    streaming: true,
    typing: {
      // Send immediately and repeat every 4s (Telegram clears indicator after ~5s)
      send: () => bot.sendTyping(chatId),
      intervalMs: 4000,
    },
    formatToolResult,
    reportError: reportResponseError,
    notifySendFailure: async (errorMessage) => {
      await bot.postPlainMessage(chatId, `⚠️ 發送失敗：${errorMessage}`);
    },
    post: async (text) => {
      const id =
        replyToId !== null
          ? await bot.postReply(chatId, replyToId, text)
          : await bot.postMessageRaw(chatId, text);
      currentResponseId = String(id);
      return currentResponseId;
    },
    update: (id, text) => bot.updateMessage(conversationId, id, text),
    postExtra: (text) => bot.postMessageRaw(chatId, text),
    delete: async (id) => {
      await bot.deleteMessageRaw(chatId, Number(id));
      currentResponseId = null;
    },
    logBotResponse: (text, id) => bot.logBotResponse(conversationId, text, id),
    uploadFile: (filePath, title) => bot.uploadFile(conversationId, filePath, title),
  });

  return { message, responder, platform };
}
