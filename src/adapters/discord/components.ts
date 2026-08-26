import { ComponentType, MessageFlags } from "discord.js";
import type { DiscordTextPayload } from "./types.js";

export type { DiscordTextPayload } from "./types.js";

/**
 * Discord message payloads, built once for every path that sends text.
 *
 * Components V2 is a per-message choice that **cannot be undone**: once a
 * message carries the flag, `content` stops working on it forever, so a
 * response that is posted as V2 must also be edited as V2. Building every
 * outbound payload here is what keeps that true — a single path that forgets
 * would leave a message that can never be updated again.
 *
 * What it buys is the ceiling. Classic `content` caps at 2000 characters, so a
 * long answer arrived as a string of `(continued 1)` posts; V2 allows 4000
 * across a message's text, which halves that. Note the limit is the *sum* over
 * all text displays, not per display — extra components buy layout, not room.
 */

/** Sum of all text in one Components V2 message. */
export const DISCORD_V2_TEXT_LIMIT = 4000;

/**
 * A text message as Components V2.
 *
 * One Text Display rather than several: the character budget is shared, so
 * splitting prose across components would add structure without adding room,
 * and Discord renders the markdown inside a single display exactly as it
 * renders `content` today.
 */
export function discordTextPayload(text: string): DiscordTextPayload {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.TextDisplay, content: text }],
  };
}
