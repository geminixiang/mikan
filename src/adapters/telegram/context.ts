import type {
  ChatToolResult,
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
  SubagentProgressSnapshot,
} from "../../adapter.js";
import { deriveSessionKey } from "../../sessions/session-key.js";
import { subagentDashboardHeader, subagentDashboardNodeLines } from "../../subagent-progress.js";
import { createProgressiveRenderer } from "../progressive-renderer.js";
import { createChatResponseErrorReporter, formatToolArgs } from "../shared.js";
import { sanitizeTelegramHtml } from "./html.js";
import type { TelegramMessagingBot, TelegramEvent } from "./bot.js";

// Telegram message length limit is 4096 chars; 3800 leaves headroom for HTML escapes.
const MAX_LENGTH = 3800;

const formatTelegramContinuation = (partNum: number): string => `(continued ${partNum})`;

/**
 * Telegram's pipeline is HTML, not response source Markdown, so its dashboard
 * conversion lives here with the rest of that debt; content comes from the
 * snapshot module's text primitives. Labels need no escaping — the responder's
 * sanitize pass owns that.
 */
function formatSubagentProgressTelegram(snapshot: SubagentProgressSnapshot): string {
  return [
    `<b>${subagentDashboardHeader(snapshot)}</b>`,
    ...snapshot.nodes.flatMap(subagentDashboardNodeLines),
  ].join("\n");
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

  const { responder } = createProgressiveRenderer({
    label: "Telegram",
    maxLength: MAX_LENGTH,
    formatContinuation: formatTelegramContinuation,
    errorPrefix: "Error: ",
    sanitize: sanitizeTelegramHtml,
    formatSubagentProgress: formatSubagentProgressTelegram,
    supportsDeltas: true,
    typing: {
      // Send immediately and repeat every 4s (Telegram clears indicator after ~5s)
      send: () => bot.sendTyping(chatId),
      intervalMs: 4000,
    },
    formatToolResult,
    reportError: (err, operation, extra, responseId) =>
      createChatResponseErrorReporter(() => ({
        platform: "telegram",
        conversationId,
        chatId,
        messageId: message.id,
        sessionKey: message.sessionKey,
        responseMessageId: responseId,
        replyToId,
        conversationKind: message.conversationKind,
      }))(err, operation, extra),
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
    postExtra: async (text) => void (await bot.postMessageRaw(chatId, text)),
    delete: async (id) => {
      await bot.deleteMessageRaw(chatId, Number(id));
    },
    logBotResponse: (text, id) => bot.logBotResponse(conversationId, text, id),
    uploadFile: (filePath, title) => bot.uploadFile(conversationId, filePath, title),
  });

  return { message, responder, platform };
}
