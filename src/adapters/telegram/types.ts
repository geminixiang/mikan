import type { ConversationEvent } from "../../adapter.js";

export interface TelegramEvent extends ConversationEvent {
  type: "message" | "command";
  userName?: string;
}
