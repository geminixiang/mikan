# src/adapters/telegram

This directory implements the Telegram platform adapter.

## Files

- `bot.ts`: Implements Telegram message intake, replies/updates, attachment handling, typing indicators, file upload, command menu registration, and logging.
- `context.ts`: Converts Telegram events into platform-neutral `ConversationMessage` / `ConversationResponder` objects and formats output in Telegram HTML mode.
- `html.ts`: Escapes and sanitizes Telegram HTML to avoid sending markup unsupported by Telegram.
- `types.ts`: The Telegram `ConversationEvent` shape.

## Behavior notes

- Telegram's response pipeline is HTML rather than the response-source Markdown
  other adapters pass through, so anything with structure (the subagent progress
  dashboard, tool results) is converted here before the shared renderer's
  sanitize pass.
- Session scope: a private chat is one persistent session. In a group, a reply
  scopes the session to the message it replies to, and a top-level message gets
  its own scoped session keyed by its message id.
