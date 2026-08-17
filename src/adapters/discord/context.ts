import {
  createConversationMessage,
  type ConversationMessage,
  type ConversationResponder,
  type MessagingInfo,
} from "../../adapter.js";
import { resolveChatSessionKey } from "../../sessions/session-key.js";
import { createProgressiveRenderer, formatMarkdownToolResult } from "../progressive-renderer.js";
import { DISCORD_V2_TEXT_LIMIT } from "./components.js";
import { formatDiscordMarkdown } from "./format.js";
import type { DiscordMessagingBot, DiscordEvent } from "./bot.js";
import type { OfficeAddress } from "../../adapter.js";

// Components V2 allows 4000 characters across a message's text, against 2000
// for classic content — the reason for using it at all. The margin leaves room
// for the working indicator and for the continuation marker on a split.
const MAX_LENGTH = DISCORD_V2_TEXT_LIMIT - 100;

const formatDiscordContinuation = (partNum: number): string => `*(continued ${partNum})*`;

export function createDiscordAdapters(
  event: DiscordEvent,
  bot: DiscordMessagingBot,
): {
  address: OfficeAddress;
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  const conversationId = event.conversationId;
  const channelId = conversationId;
  const threadTargetId = event.origin.kind === "interactive" ? event.thread_ts : undefined;
  const replyTargetId = event.origin.kind === "interactive" ? event.ts : undefined;

  const message = createConversationMessage({
    platform: "discord",
    conversationId,
    address: event.address,
    id: event.ts,
    origin: event.origin,
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

  // The bot's getMessagingInfo() is the single authority for platform info.
  const platform: MessagingInfo = bot.getMessagingInfo();

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
      // Send immediately and repeat every 8s (Discord clears indicator after ~10s)
      send: () => bot.sendTyping(channelId),
      intervalMs: 8000,
      stopOnSend: true,
    },
    // The last step before sending: the model writes standard markdown, and
    // the parts Discord cannot render are converted here rather than by
    // constraining what the model may write.
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
    post: async (text) => {
      return postFirst(text);
    },
    update: (id, text) => bot.updateMessageRaw(channelId, id, text),
    // Returns the id so the renderer can edit this overflow message on the
    // next redraw instead of posting another copy of the tail.
    postExtra: async (text, responseId) => {
      if (threadTargetId) return bot.postInThread(channelId, threadTargetId, text);
      if (replyTargetId) return bot.postReply(channelId, replyTargetId, text);
      if (responseId !== null) return bot.postReply(channelId, responseId, text);
      return bot.postMessage(channelId, text);
    },
    delete: async (id) => {
      await bot.deleteMessageRaw(channelId, id);
    },
    logBotResponse: (text, id) => bot.logBotResponse(channelId, text, id),
    uploadFile: (filePath, title) => bot.uploadFile(channelId, filePath, title),
  });

  return { address: message.address, message, responder, platform };
}
