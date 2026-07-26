import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../../adapter.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import { createBufferedResponder, formatMarkdownToolResult } from "../buffered-responder.js";
import { createChatResponseErrorReporter } from "../shared.js";
import type { DiscordMessagingBot, DiscordEvent } from "./bot.js";

// Discord hard limit is 2000 chars; 1900 leaves headroom for working indicator.
const MAX_LENGTH = 1900;

const formatDiscordContinuation = (partNum: number): string => `*(continued ${partNum})*`;

function isDiscordMessageReference(id: string | undefined): id is string {
  return typeof id === "string" && id !== "" && !id.startsWith("event:");
}

export function createDiscordAdapters(
  event: DiscordEvent,
  bot: DiscordMessagingBot,
): {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  const conversationId = event.conversationId;
  const channelId = conversationId;
  const threadTargetId = isDiscordMessageReference(event.thread_ts) ? event.thread_ts : undefined;
  const replyTargetId = isDiscordMessageReference(event.ts) ? event.ts : undefined;

  const message: ConversationMessage = {
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
  };

  // The bot's getMessagingInfo() is the single authority for platform info.
  const platform: MessagingInfo = bot.getMessagingInfo();

  let currentResponseId: string | null = null;

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "discord",
    conversationId,
    channelId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: currentResponseId,
    threadTs: threadTargetId,
    replyTargetId,
    conversationKind: message.conversationKind,
  }));

  function postFirst(text: string): Promise<string> {
    if (threadTargetId) return bot.postInThread(channelId, threadTargetId, text);
    if (replyTargetId) return bot.postReply(channelId, replyTargetId, text);
    return bot.postMessage(channelId, text);
  }

  const { responder } = createBufferedResponder({
    label: "Discord",
    maxLength: MAX_LENGTH,
    formatContinuation: formatDiscordContinuation,
    errorPrefix: "*Error:* ",
    workingIndicator: " ...",
    streaming: true,
    typing: {
      // Send immediately and repeat every 8s (Discord clears indicator after ~10s)
      send: () => bot.sendTyping(channelId),
      intervalMs: 8000,
      stopOnSend: true,
    },
    formatToolResult: formatMarkdownToolResult,
    reportError: reportResponseError,
    post: async (text) => {
      currentResponseId = await postFirst(text);
      return currentResponseId;
    },
    update: (id, text) => bot.updateMessageRaw(channelId, id, text),
    postExtra: (text, responseId) => {
      if (threadTargetId) return bot.postInThread(channelId, threadTargetId, text);
      if (replyTargetId) return bot.postReply(channelId, replyTargetId, text);
      if (responseId !== null) return bot.postReply(channelId, responseId, text);
      return bot.postMessage(channelId, text);
    },
    delete: async (id) => {
      await bot.deleteMessageRaw(channelId, id);
      currentResponseId = null;
    },
    logBotResponse: (text, id) => bot.logBotResponse(channelId, text, id),
    uploadFile: (filePath, title) => bot.uploadFile(channelId, filePath, title),
  });

  return { message, responder, platform };
}
