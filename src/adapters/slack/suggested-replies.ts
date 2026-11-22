import type { KnownBlock } from "@slack/types";
import { hasRoomForSlackBlock } from "./blocks.js";
import type { SlackBlockAction } from "./types.js";

const SUGGESTED_REPLIES_BLOCK_ID = "suggested_replies";
const SUGGESTED_REPLY_ACTION_PREFIX = "suggested_reply_";
const BUTTON_LABEL_LIMIT = 75;
const BUTTON_VALUE_LIMIT = 2000;
const ELLIPSIS = "…";

function buttonLabel(suggestion: string): string {
  if (suggestion.length <= BUTTON_LABEL_LIMIT) return suggestion;
  let label = "";
  for (const character of suggestion) {
    if (label.length + character.length > BUTTON_LABEL_LIMIT - ELLIPSIS.length) break;
    label += character;
  }
  return `${label}${ELLIPSIS}`;
}

export function withSuggestedReplies<T extends { blocks: KnownBlock[] }>(
  message: T,
  suggestions: readonly string[] | undefined,
): T {
  const sendable = (suggestions ?? []).filter(
    (suggestion) => suggestion.length <= BUTTON_VALUE_LIMIT,
  );
  if (sendable.length === 0 || !hasRoomForSlackBlock(message.blocks)) return message;
  const block: KnownBlock = {
    type: "actions",
    block_id: SUGGESTED_REPLIES_BLOCK_ID,
    elements: sendable.map((suggestion, index) => ({
      type: "button",
      action_id: `${SUGGESTED_REPLY_ACTION_PREFIX}${index + 1}`,
      text: { type: "plain_text", text: buttonLabel(suggestion) },
      value: suggestion,
    })),
  };
  return { ...message, blocks: [...message.blocks, block] };
}

export function suggestedReplyOf(action: SlackBlockAction): string | undefined {
  if (!action.action_id.startsWith(SUGGESTED_REPLY_ACTION_PREFIX)) return undefined;
  return action.value?.trim() || undefined;
}

function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function withTappedSuggestedReply(
  blocks: readonly object[],
  tap: { userId: string; text: string },
): object[] {
  return blocks.map((block) =>
    "block_id" in block && block.block_id === SUGGESTED_REPLIES_BLOCK_ID
      ? {
          type: "context",
          block_id: SUGGESTED_REPLIES_BLOCK_ID,
          elements: [{ type: "mrkdwn", text: `<@${tap.userId}>: ${escapeMrkdwn(tap.text)}` }],
        }
      : block,
  );
}
