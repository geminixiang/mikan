# src/adapters/discord

This directory implements the Discord platform adapter.

## Files

- `bot.ts`: Implements Discord event intake, message/reply updates, attachment handling, direct messages, and channel/user lookup.
- `context.ts`: Converts Discord events into platform-neutral `ChatMessage` / `ChatResponseContext` objects and formats Discord Markdown/tool output.
