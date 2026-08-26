import { createConversationMessage } from "../../adapter.js";
import type { ChatToolResult, ConversationContext } from "../../adapter.js";
import { deriveSessionKey } from "../../sessions/session-key.js";
import { createProgressiveRenderer } from "../progressive-renderer.js";
import { formatToolArgs } from "../shared.js";
import type { TelegramMessagingBot, TelegramEvent } from "./bot.js";

// A rich message allows far more than the 4096 a plain message did; this stays
// well inside it, and the headroom is now for the continuation marker alone
// rather than for HTML escapes that no longer happen.
const MAX_LENGTH = 30000;

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
): ConversationContext {
  const conversationId = event.conversationId;
  const chatId = parseInt(conversationId);
  const replyToId = event.thread_ts ? parseInt(event.thread_ts) : null;

  const message = createConversationMessage({
    platform: "telegram",
    conversationId,
    address: event.address,
    id: event.ts,
    sessionKey: deriveSessionKey(event),
    conversationKind: event.conversationKind,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
  });

  // The bot's getMessagingInfo() is the single authority for platform info.
  const platform = bot.getMessagingInfo();

  const { responder } = createProgressiveRenderer({
    label: "Telegram",
    maxLength: MAX_LENGTH,
    formatContinuation: formatTelegramContinuation,
    errorPrefix: "Error: ",
    supportsDeltas: true,
    typing: {
      // Send immediately and repeat every 4s (Telegram clears indicator after ~5s)
      send: () => bot.sendTyping(chatId),
      intervalMs: 4000,
    },
    formatToolResult,
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
    // Returns the id so the renderer can edit this overflow message on the
    // next redraw instead of posting another copy of the tail.
    postExtra: async (text) => bot.postMessageRaw(chatId, text),
    delete: async (id) => {
      await bot.deleteMessageRaw(chatId, Number(id));
    },
    logBotResponse: (text, id) => bot.logBotResponse(conversationId, text, id),
    uploadFile: (filePath, title) => bot.uploadFile(conversationId, filePath, title),
  });

  return { address: message.address, message, responder, platform };
}
