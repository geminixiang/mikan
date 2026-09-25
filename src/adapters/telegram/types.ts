import type { Api, BotError } from "grammy";
import type { Message } from "grammy/types";
import type { ConversationEvent } from "../../types.js";
import type { Workspace } from "../../office/types.js";
import type { TelegramMessagingBot } from "./bot.js";

export interface TelegramEvent extends ConversationEvent {
  type: "message" | "command";
  userName?: string;
}

interface TelegramMessageUpdate {
  message: Message | undefined;
}

export type TelegramUpdateHandler = (ctx: TelegramMessageUpdate) => Promise<void>;

export interface TelegramClient {
  api: Pick<
    Api,
    | "getMe"
    | "setMyCommands"
    | "setMessageReaction"
    | "editMessageText"
    | "sendRichMessage"
    | "sendMessage"
    | "deleteMessage"
    | "sendChatAction"
    | "sendDocument"
    | "getFile"
  >;
  catch(errorHandler: (error: BotError) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  command(command: string, handler: TelegramUpdateHandler): unknown;
  on(filter: "message", handler: TelegramUpdateHandler): unknown;
}

export interface TelegramMessagingBotOptions {
  token: string;
  workspace: Workspace;
  client?: TelegramClient;
}

export type TelegramResponseBot = Pick<
  TelegramMessagingBot,
  | "getMessagingInfo"
  | "sendTyping"
  | "postPlainMessage"
  | "postReply"
  | "postMessageRaw"
  | "updateMessage"
  | "deleteMessageRaw"
  | "logBotResponse"
  | "uploadFile"
  | "addReaction"
>;
