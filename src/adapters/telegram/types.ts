import type { BotEvent } from "../../adapter.js";

export interface TelegramEvent extends BotEvent {
  type: "message" | "command";
  userName?: string;
}
