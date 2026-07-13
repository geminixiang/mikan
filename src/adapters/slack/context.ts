import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../../adapter.js";
import { type SlackMessagingBot, type SlackEvent } from "./bot.js";
import { createSlackResponseContext } from "./response-lifecycle.js";
import { planSlackAdapterSession } from "./session.js";
export type { SlackAdapterOptions } from "./types.js";
import type { SlackAdapterOptions } from "./types.js";

export function createSlackAdapters(
  event: SlackEvent,
  slack: SlackMessagingBot,
  adapterOptions: SlackAdapterOptions = {},
): {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  const sessionPlan = planSlackAdapterSession(event, {
    initialMessageTs: adapterOptions.initialMessageTs,
  });
  const user = slack.getUser(event.user);

  const message: ConversationMessage = {
    id: event.ts,
    sessionKey: sessionPlan.sessionKey,
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

  // The bot's getMessagingInfo() is the single authority for platform info;
  // context factories compose from it instead of maintaining a second copy.
  const platform: MessagingInfo = slack.getMessagingInfo();

  const responder = createSlackResponseContext({
    event,
    slack,
    sessionPlan,
    replyMode: adapterOptions.replyMode ?? "top-level",
    message,
  });

  return { message, responder, platform };
}
