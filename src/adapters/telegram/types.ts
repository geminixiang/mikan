import type { Api, BotError } from "grammy";
import type { CallbackQuery, Message } from "grammy/types";
import type { ConversationEvent } from "../../types.js";
import type { Workspace } from "../../office/types.js";
import type { TelegramMessagingBot } from "./bot.js";

export interface TelegramEvent extends ConversationEvent {
  type: "message" | "command";
  userName?: string;
}

interface TelegramUpdate {
  message: Message | undefined;
  callbackQuery: CallbackQuery | undefined;
}

export type TelegramUpdateHandler = (ctx: TelegramUpdate) => Promise<void>;

export interface TelegramClient {
  api: Pick<
    Api,
    | "getMe"
    | "setMyCommands"
    | "setMessageReaction"
    | "editMessageText"
    | "editMessageReplyMarkup"
    | "answerCallbackQuery"
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
  on(filter: "message" | "callback_query:data", handler: TelegramUpdateHandler): unknown;
}

export interface TelegramMessagingBotOptions {
  token: string;
  workspace: Workspace;
  client?: TelegramClient;
  onPollingFailure?: (error: Error) => void;
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
