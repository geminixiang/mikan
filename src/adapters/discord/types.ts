import type { BotEvent } from "../../adapter.js";

export interface DiscordEvent extends BotEvent {
  type: "mention" | "dm";
  userName?: string;
}
