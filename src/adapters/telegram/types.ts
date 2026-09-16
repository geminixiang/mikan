import type { ConversationEvent } from "../index.js";

export interface TelegramEvent extends ConversationEvent {
  type: "message" | "command";
  userName?: string;
}
