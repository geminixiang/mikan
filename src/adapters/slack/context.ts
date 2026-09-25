import type { ConversationContext } from "../../types.js";
import { createConversationMessage } from "../../office/index.js";
import type { SlackEvent, SlackAdapterOptions, SlackResponderBot } from "./types.js";
import { createSlackResponseContext } from "./response-lifecycle.js";
import { planSlackAdapterSession } from "./session.js";

export function createSlackAdapters(
  event: SlackEvent,
  slack: SlackResponderBot,
  adapterOptions: SlackAdapterOptions = {},
): ConversationContext {
  const sessionPlan = planSlackAdapterSession(event, {
    initialMessageTs: adapterOptions.initialMessageTs,
  });
  const user = slack.getUser(event.user);

  const message = createConversationMessage({
    platform: "slack",
    conversationId: event.address.conversationId,
    address: event.address,
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
  });

  const platform = slack.getMessagingInfo();

  const responder = createSlackResponseContext({
    event,
    slack,
    sessionPlan,
    replyMode: adapterOptions.replyMode ?? "top-level",
    message,
  });

  return { address: message.address, message, responder, platform };
}
