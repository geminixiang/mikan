import type { ConversationContext } from "../../types.js";
import { deriveSessionKey } from "../../sessions/session-key.js";
import { createProgressiveRenderer } from "../progressive-renderer.js";
import { createEventMessage } from "../shared.js";
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
    post: async (text) => {
      const id =
        replyToId !== null
          ? await bot.postReply(chatId, replyToId, text)
          : await bot.postMessageRaw(chatId, text);
      return String(id);
    },
    update: (id, text) => bot.updateMessage(conversationId, id, text),
    postExtra: (text) => bot.postMessageRaw(chatId, text),
    delete: (id) => bot.deleteMessageRaw(chatId, Number(id)),
    logBotResponse: (text, id) =>
      bot.logBotResponse(conversationId, text, id, undefined, {
        answer: { replyTo: message.id, sessionKey: message.sessionKey },
      }),
    uploadFile: (filePath, title) => bot.uploadFile(conversationId, filePath, title),
    react: (emoji) => bot.addReaction(conversationId, event.ts, emoji),
  });

  return { address: message.address, message, responder, platform };
}
