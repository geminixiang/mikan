# src/adapters/slack

This directory implements the Slack platform adapter and Slack-specific session/thread rules.

## Files

- `bot.ts`: Implements the Slack Socket Mode/Web API bot, including events, backfill, threads, files, replies, working state, and logging.
- `context.ts`: Builds the Slack `ChatResponseContext`, including mrkdwn formatting, long-message fallback, tool output, and working-state display.
- `index.ts`: Re-exports the Slack bot and context modules.
- `session.ts`: Handles Slack channel/thread session keys, root timestamps, and event-anchor planning.
- `thread-manager.ts`: Wraps the generic chat session manager for Slack thread registration, bootstrap waiting, and scope resolution.

## Subdirectories

- `tools/`: Agent tools required by the Slack adapter.
