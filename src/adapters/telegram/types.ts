import type { ConversationEvent } from "../../types.js";

export interface TelegramEvent extends ConversationEvent {
  type: "message" | "command";
  userName?: string;
}
