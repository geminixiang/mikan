# src/adapters/telegram

This directory implements the Telegram platform adapter.

## Files

- `bot.ts`: Implements Telegram message intake, replies/updates, attachment handling, typing indicators, file upload, and logging.
- `context.ts`: Converts Telegram events into platform-neutral `ConversationMessage` / `ConversationResponder` objects and formats output in Telegram HTML mode.
- `html.ts`: Escapes and sanitizes Telegram HTML to avoid sending markup unsupported by Telegram.
