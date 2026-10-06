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
- grammY retries network and server errors during long polling by itself, but
  ends polling on `401` (revoked token) and `409` (another process polls the same
  bot). The process would otherwise stay up while receiving nothing, so
  `start()` hands that failure to `onPollingFailure`; `main.ts` logs it and exits
  with code 1 for the process manager to restart. A failure after `stop()` is the
  normal end of polling and is ignored.
