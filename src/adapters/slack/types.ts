import type { ConversationKind } from "../../adapter.js";
import type { Attachment } from "../../store.js";

export interface SlackEvent {
  type: "mention" | "dm";
  conversationId: string;
  conversationKind: ConversationKind;
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
  /** Processed attachments with local paths (populated after logUserMessage) */
  attachments?: Attachment[];
  /** Session key passed through to ConversationEvent so handleEvent uses the correct persistent session */
  sessionKey?: string;
}

export interface SlackUser {
  id: string;
  userName: string;
  displayName: string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

export interface SlackAdapterOptions {
  initialMessageTs?: string;
  replyMode?: "top-level" | "thread";
}

export type SlackSessionRef =
  | { kind: "channel"; channelId: string }
  | { kind: "thread"; channelId: string; threadTs: string };

export interface SlackAdapterSessionPlan {
  sessionKey: string;
  rootTs?: string;
  initialMessageTs?: string;
  isThreaded: boolean;
}

export interface SlackEventAnchorRunPlan<T = SlackEvent> {
  event: T;
  initialMessageTs?: string;
}

// ---------------------------------------------------------------------------
// Block action payload shapes (subset used by handleBlockAction /
// handleSlackInteraction — @slack/types does not export these)
// ---------------------------------------------------------------------------

export interface SlackBlockAction {
  action_id: string;
  block_id?: string;
  type?: string;
  value?: string;
  selected_option?: { text?: { text?: string }; value?: string };
  selected_options?: Array<{ text?: { text?: string }; value?: string }>;
}

export interface SlackBlockActionBody {
  actions?: SlackBlockAction[];
  container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
  user?: { id?: string; username?: string; name?: string };
}
