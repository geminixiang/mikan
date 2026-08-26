import type { ConversationKind, OfficeAddress } from "../../adapter.js";
import type { Attachment } from "../../types.js";

export interface SlackEvent {
  address: OfficeAddress;
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
  /** From users.list is_bot; absent when the entry predates the flag. */
  isBot?: boolean;
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

/**
 * Host-side Slack operations for the Slack tool pack, keyed by conversation.
 * main.ts implements these against the running SlackMessagingBot.
 */
export interface PlatformSlackOps {
  postBlocks(
    conversationId: string,
    args: { text: string; blocks: object[]; threadTs?: string },
  ): Promise<{ ts: string }>;
  updateBlocks(
    conversationId: string,
    args: { ts: string; text: string; blocks: object[]; threadTs?: string },
  ): Promise<void>;
  ownsBlockKitMessage(conversationId: string, ts: string, threadTs?: string): boolean;
}

/** Conversation-bound Slack Block Kit operations, provided by the host. */
export interface SlackBlockKitOps {
  postBlocks(args: { text: string; blocks: object[]; threadTs?: string }): Promise<{ ts: string }>;
  updateBlocks(args: { ts: string; text: string; blocks: object[] }): Promise<void>;
}

// ── assistant pane surface ──────────────────────────────────────────────────

export interface AssistantThreadPayload {
  user_id?: string;
  channel_id?: string;
  thread_ts?: string;
  context?: AgentContext;
}

/**
 * Which channel the person is viewing beside the pane. Slack spells this
 * `context` on `app_home_opened` and `app_context_changed`, and `app_context`
 * on `message.im` — the asymmetry is Slack's, normalized here.
 */
export interface AgentContext {
  channel_id?: string;
  team_id?: string;
  enterprise_id?: string | null;
}

export interface SuggestedPrompt {
  title: string;
  message: string;
}

/** What the adapter needs from the bot to serve this surface. */
export interface AssistantSurfaceOps {
  postInThread(channel: string, threadTs: string, text: string): Promise<string>;
  /** `threadTs` omitted pins the prompts to the DM instead of one thread. */
  setSuggestedPrompts(
    channel: string,
    threadTs: string | undefined,
    prompts: SuggestedPrompt[],
  ): Promise<void>;
  setTitle(channel: string, threadTs: string, title: string): Promise<void>;
  /** Human-readable channel name for context, when the bot knows it. */
  channelName(channelId: string): string | undefined;
}
