import type {
  ApplicationCommandDataResolvable,
  Attachment,
  ChannelType,
  Client,
  ClientUser,
  Events,
  GuildMember,
  MessageReference,
  User,
} from "discord.js";
import type { ConversationEvent } from "../../types.js";
import type { Workspace } from "../../office/types.js";
import type { DiscordMessagingBot } from "./bot.js";

export interface DiscordEvent extends ConversationEvent {
  type: "mention" | "dm";
  userName?: string;
}

export interface DiscordTextPayload {
  flags: number;
  components: Array<{ type: number; content: string }>;
}

export interface DiscordIncomingChannel {
  type: ChannelType;
  isThread(): boolean;
  parentId?: string | null;
  name?: string | null;
}

export type DiscordAttachmentSource = Pick<Attachment, "name" | "url">;

export interface DiscordIncomingMessage {
  id: string;
  channelId: string;
  createdTimestamp: number;
  createdAt: Date;
  content: string;
  author: Pick<User, "id" | "username" | "bot">;
  member: Pick<GuildMember, "displayName"> | null;
  channel: DiscordIncomingChannel;
  mentions: { users: { has(userId: string): boolean } };
  reference: Pick<MessageReference, "messageId"> | null;
  attachments: ReadonlyMap<string, DiscordAttachmentSource>;
}

interface DiscordReplyOptions {
  content: string;
  ephemeral: boolean;
}

export interface DiscordCommandInteraction extends DiscordIncomingInteraction {
  id: string;
  commandName: string;
  channelId: string;
  createdTimestamp: number;
  user: Pick<User, "id" | "username">;
  channel: DiscordIncomingChannel | null;
  options: { getString(name: string): string | null };
  replied: boolean;
  deferred: boolean;
  inGuild(): boolean;
  reply(options: DiscordReplyOptions): Promise<unknown>;
  followUp(options: DiscordReplyOptions): Promise<unknown>;
  editReply(options: { content: string }): Promise<unknown>;
  deferReply(options: { ephemeral: boolean }): Promise<unknown>;
}

export interface DiscordIncomingInteraction {
  isChatInputCommand(): this is DiscordCommandInteraction;
}

export interface DiscordReadyClient {
  user: Pick<ClientUser, "id" | "tag">;
  application: {
    commands: { set(commands: readonly ApplicationCommandDataResolvable[]): Promise<unknown> };
  };
}

export interface DiscordClient {
  channels: Pick<Client["channels"], "fetch">;
  users: Pick<Client["users"], "fetch">;
  guilds: Pick<Client["guilds"], "cache">;
  once(event: Events.ClientReady, listener: (client: DiscordReadyClient) => void): unknown;
  once(event: Events.Error, listener: (error: Error) => void): unknown;
  on(
    event: Events.InteractionCreate,
    listener: (interaction: DiscordIncomingInteraction) => void,
  ): unknown;
  on(event: Events.MessageCreate, listener: (message: DiscordIncomingMessage) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
}

export interface DiscordMessagingBotOptions {
  token: string;
  workspace: Workspace;
  client?: DiscordClient;
}

export type DiscordResponseBot = Pick<
  DiscordMessagingBot,
  | "getMessagingInfo"
  | "postInThread"
  | "postReply"
  | "postMessage"
  | "updateMessageRaw"
  | "deleteMessageRaw"
  | "sendTyping"
  | "logBotResponse"
  | "uploadFile"
  | "addReaction"
>;
