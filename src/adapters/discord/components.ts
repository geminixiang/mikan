import { ComponentType, MessageFlags } from "discord.js";
import type { DiscordTextPayload } from "./types.js";

export type { DiscordTextPayload } from "./types.js";

export const DISCORD_V2_TEXT_LIMIT = 4000;

export function discordTextPayload(text: string): DiscordTextPayload {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.TextDisplay, content: text }],
  };
}
