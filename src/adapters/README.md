# src/adapters

This directory contains chat platform adapters and shared adapter helpers.

## Files

- `shared.ts`: Provides platform-shared retry, queueing, long-text splitting, message logging, stop-target resolution, and tool-argument formatting.

## Subdirectories

- `discord/`: Discord bot implementation and Discord response context.
- `slack/`: Slack bot, Slack session/thread rules, and Slack response context.
- `telegram/`: Telegram bot, Telegram HTML sanitization, and Telegram response context.
