import type { InlineKeyboardMarkup } from "grammy/types";
import { isJobRunId } from "../../events/jobs.js";
import type { ConversationContext } from "../../types.js";
import { deriveSessionKey } from "../../sessions/session-key.js";
import { createProgressiveRenderer } from "../progressive-renderer.js";
import { createEventMessage } from "../shared.js";
import { suggestedReplyKeyboard, TELEGRAM_TAP_TS_PREFIX } from "./suggested-replies.js";
import type { TelegramEvent, TelegramResponseBot } from "./types.js";

const MAX_LENGTH = 30000;

export function createTelegramAdapters(
  event: TelegramEvent,
  bot: TelegramResponseBot,
): ConversationContext {
  const conversationId = event.address.conversationId;
  const chatId = parseInt(conversationId);
  const replyToId = event.thread_ts ? parseInt(event.thread_ts) : null;

  const message = createEventMessage({
    platform: "telegram",
    event,
    sessionKey: deriveSessionKey(event),
  });

  const platform = bot.getMessagingInfo();
  const post = async (text: string, keyboard?: InlineKeyboardMarkup): Promise<string> => {
    const markup = keyboard ? [keyboard] : [];
    const id =
      replyToId !== null
        ? await bot.postReply(chatId, replyToId, text, ...markup)
        : await bot.postMessageRaw(chatId, text, ...markup);
    return String(id);
  };

  const { responder } = createProgressiveRenderer({
    label: "Telegram",
    maxLength: MAX_LENGTH,
    formatContinuation: (partNum: number): string => `(continued ${partNum})`,
    errorPrefix: "Error: ",
    showsPartialAnswer: true,
    typing: {
      send: () => bot.sendTyping(chatId),
      intervalMs: 4000,
    },
    responseErrorContext: (responseId) => ({
      platform: "telegram",
      conversationId,
      chatId,
      messageId: message.id,
      sessionKey: message.sessionKey,
      responseMessageId: responseId,
      replyToId,
      conversationKind: message.conversationKind,
    }),
    notifySendFailure: async (errorMessage) => {
      await bot.postPlainMessage(chatId, `⚠️ 發送失敗：${errorMessage}`);
    },
    post: (text) => post(text),
    update: (id, text) => bot.updateMessage(conversationId, id, text),
    postExtra: (text) => bot.postMessageRaw(chatId, text),
    withSuggestions: (suggestions) => {
      const keyboard = suggestedReplyKeyboard(suggestions, message.sessionKey);
      return {
        post: (text) => post(text, keyboard),
        update: (id, text) => bot.updateMessage(conversationId, id, text, keyboard),
        postExtra: (text) => bot.postMessageRaw(chatId, text, keyboard),
      };
    },
    delete: (id) => bot.deleteMessageRaw(chatId, Number(id)),
    logBotResponse: (text, id) =>
      bot.logBotResponse(conversationId, text, id, undefined, {
        answer: { replyTo: message.id, sessionKey: message.sessionKey },
      }),
    uploadFile: (filePath, title) => bot.uploadFile(conversationId, filePath, title),
    react:
      isJobRunId(event.ts) || event.ts.startsWith(TELEGRAM_TAP_TS_PREFIX)
        ? undefined
        : (emoji) => bot.addReaction(conversationId, event.ts, emoji),
  });

  return { address: message.address, message, responder, platform };
}
