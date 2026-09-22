import { createConversationMessage, type ConversationContext } from "../index.js";
import { resolveChatSessionKey } from "../../sessions/session-key.js";
import { createProgressiveRenderer, formatMarkdownToolResult } from "../progressive-renderer.js";
import { DISCORD_V2_TEXT_LIMIT } from "./components.js";
import { formatDiscordMarkdown } from "./format.js";
import type { DiscordMessagingBot, DiscordEvent } from "./bot.js";

const MAX_LENGTH = DISCORD_V2_TEXT_LIMIT - 100;

const formatDiscordContinuation = (partNum: number): string => `*(continued ${partNum})*`;

function isDiscordMessageReference(id: string | undefined): id is string {
  return typeof id === "string" && id !== "" && !id.startsWith("event:");
}

export function createDiscordAdapters(
  event: DiscordEvent,
  bot: DiscordMessagingBot,
): ConversationContext {
  const conversationId = event.conversationId;
  const channelId = conversationId;
  const threadTargetId = isDiscordMessageReference(event.thread_ts) ? event.thread_ts : undefined;
  const replyTargetId = isDiscordMessageReference(event.ts) ? event.ts : undefined;

  const message = createConversationMessage({
    platform: "discord",
    conversationId,
    address: event.address,
    id: event.ts,
    sessionKey:
      event.sessionKey ??
      resolveChatSessionKey({
        conversationId,
        conversationKind: event.conversationKind,
        messageId: event.ts,
        persistentTopLevel: true,
        threadTs: event.thread_ts,
      }),
    conversationKind: event.conversationKind,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
  });

  const platform = bot.getMessagingInfo();

  function postFirst(text: string): Promise<string> {
    if (threadTargetId) return bot.postInThread(channelId, threadTargetId, text);
    if (replyTargetId) return bot.postReply(channelId, replyTargetId, text);
    return bot.postMessage(channelId, text);
  }

  const { responder } = createProgressiveRenderer({
    label: "Discord",
    maxLength: MAX_LENGTH,
    formatContinuation: formatDiscordContinuation,
    errorPrefix: "*Error:* ",
    workingIndicator: " ...",
    supportsDeltas: true,
    typing: {
      send: () => bot.sendTyping(channelId),
      intervalMs: 8000,
      stopOnSend: true,
    },
    prepareSource: (text) => formatDiscordMarkdown(text),
    formatToolResult: formatMarkdownToolResult,
    responseErrorContext: (responseId) => ({
      platform: "discord",
      conversationId,
      channelId,
      messageId: message.id,
      sessionKey: message.sessionKey,
      responseMessageId: responseId,
      threadTs: threadTargetId,
      replyTargetId,
      conversationKind: message.conversationKind,
    }),
    post: postFirst,
    update: (id, text) => bot.updateMessageRaw(channelId, id, text),
    postExtra: async (text, responseId) => {
      if (threadTargetId) return bot.postInThread(channelId, threadTargetId, text);
      if (replyTargetId) return bot.postReply(channelId, replyTargetId, text);
      if (responseId !== null) return bot.postReply(channelId, responseId, text);
      return bot.postMessage(channelId, text);
    },
    delete: (id) => bot.deleteMessageRaw(channelId, id),
    logBotResponse: (text, id) => bot.logBotResponse(channelId, text, id),
    uploadFile: (filePath, title) => bot.uploadFile(channelId, filePath, title),
    react: replyTargetId ? (emoji) => bot.addReaction(channelId, replyTargetId, emoji) : undefined,
  });

  return { address: message.address, message, responder, platform };
}
