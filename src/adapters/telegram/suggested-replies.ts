import type { CallbackQuery, InlineKeyboardMarkup } from "grammy/types";
import { threadSuffixOf } from "../../sessions/session-key.js";

const SUGGESTED_REPLY_DATA_PREFIX = "suggested_reply:";
const TAPPED_DATA = "tapped_suggested_reply";
const BUTTON_LABEL_LIMIT = 128;
const CALLBACK_DATA_BYTE_LIMIT = 64;
const ELLIPSIS = "…";

export const TELEGRAM_TAP_TS_PREFIX = "tap:";

export interface TappedSuggestedReply {
  text: string;
  sessionSuffix: string | undefined;
}

export function suggestedReplyKeyboard(
  suggestions: readonly string[],
  sessionKey: string,
): InlineKeyboardMarkup | undefined {
  const suffix = threadSuffixOf(sessionKey) ?? "";
  const rows = suggestions
    .filter((suggestion) => suggestion.length <= BUTTON_LABEL_LIMIT)
    .map((suggestion, index) => [
      {
        text: suggestion,
        callback_data: `${SUGGESTED_REPLY_DATA_PREFIX}${index + 1}:${suffix}`,
      },
    ]);
  const fits = rows.every(
    ([button]) => Buffer.byteLength(button!.callback_data) <= CALLBACK_DATA_BYTE_LIMIT,
  );
  return rows.length > 0 && fits ? { inline_keyboard: rows } : undefined;
}

export function tappedSuggestedReplyOf(
  query: Pick<CallbackQuery, "data" | "message">,
): TappedSuggestedReply | undefined {
  const data = query.data;
  if (!data?.startsWith(SUGGESTED_REPLY_DATA_PREFIX)) return undefined;
  const keyboard =
    query.message && "reply_markup" in query.message
      ? query.message.reply_markup?.inline_keyboard
      : undefined;
  const button = keyboard
    ?.flat()
    .find((item) => "callback_data" in item && item.callback_data === data);
  if (!button) return undefined;
  const suffix = data.slice(data.indexOf(":", SUGGESTED_REPLY_DATA_PREFIX.length) + 1);
  return { text: button.text, sessionSuffix: suffix || undefined };
}

export function tappedKeyboard(userName: string, text: string): InlineKeyboardMarkup {
  const line = `${userName}: ${text}`;
  const label =
    line.length <= BUTTON_LABEL_LIMIT
      ? line
      : `${line.slice(0, BUTTON_LABEL_LIMIT - ELLIPSIS.length)}${ELLIPSIS}`;
  return { inline_keyboard: [[{ text: label, callback_data: TAPPED_DATA }]] };
}
