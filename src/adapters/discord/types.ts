import type { ConversationEvent } from "../index.js";

export interface DiscordEvent extends ConversationEvent {
  type: "mention" | "dm";
  userName?: string;
}

export interface DiscordTextPayload {
  flags: number;
  components: Array<{ type: number; content: string }>;
}
