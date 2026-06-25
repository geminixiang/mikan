import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../../adapter.js";
import { type SlackMessagingBot, type SlackEvent } from "./bot.js";
import { createSlackResponseContext } from "./response-lifecycle.js";
import { planSlackAdapterSession } from "./session.js";
export type { SlackAdapterOptions } from "./types.js";
import type { SlackAdapterOptions } from "./types.js";

const SLACK_FORMATTING_GUIDE = `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).`;

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

  const platform: MessagingInfo = {
    name: "slack",
    formattingGuide: SLACK_FORMATTING_GUIDE,
    channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
    users: slack
      .getAllUsers()
      .map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),
    diagnostics: {
      showUsageSummary: true,
    },
  };

  const responder = createSlackResponseContext({
    event,
    slack,
    sessionPlan,
    replyMode: adapterOptions.replyMode ?? "top-level",
    message,
  });

  return { message, responder, platform };
}
