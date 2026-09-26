# src/adapters/telegram

This directory implements the Telegram platform adapter.

## Behavior notes

- Telegram's response pipeline is HTML rather than the response-source Markdown
  other adapters pass through, so anything with structure (the subagent progress
  dashboard, tool results) is converted here before the shared renderer's
  sanitize pass.
- Session scope: a private chat is one persistent session. In a group, a reply
  scopes the session to the message it replies to, and a top-level message gets
  its own scoped session keyed by its message id.
