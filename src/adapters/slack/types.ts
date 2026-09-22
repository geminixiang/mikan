import type { ConversationKind, OfficeAddress } from "../index.js";
import type { Attachment } from "../../types.js";

export interface SlackEvent {
  address: OfficeAddress;
  type: "mention" | "dm";
  conversationKind: ConversationKind;
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
  attachments?: Attachment[];
  sessionKey?: string;
}

export interface SlackUser {
  id: string;
  userName: string;
  displayName: string;
  isBot?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  isExternallyShared?: boolean;
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

export interface SlackBlockKitOps {
  postBlocks(args: { text: string; blocks: object[]; threadTs?: string }): Promise<{ ts: string }>;
  updateBlocks(args: { ts: string; text: string; blocks: object[] }): Promise<void>;
}

export interface AssistantThreadPayload {
  user_id?: string;
  channel_id?: string;
  thread_ts?: string;
  context?: AgentContext;
}

export interface AgentContext {
  channel_id?: string;
  team_id?: string;
  enterprise_id?: string | null;
}

export interface SuggestedPrompt {
  title: string;
  message: string;
}

export interface AssistantSurfaceOps {
  postInThread(channel: string, threadTs: string, text: string): Promise<string>;
  setSuggestedPrompts(
    channel: string,
    threadTs: string | undefined,
    prompts: SuggestedPrompt[],
  ): Promise<void>;
  setTitle(channel: string, threadTs: string, title: string): Promise<void>;
  channelName(channelId: string): string | undefined;
}
