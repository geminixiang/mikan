import type { ConversationEvent } from "../../adapter.js";

export interface DiscordEvent extends ConversationEvent {
  type: "mention" | "dm";
  userName?: string;
}
