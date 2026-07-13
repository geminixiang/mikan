# src/adapters

This directory contains chat platform adapters and shared adapter helpers.

## Files

- `intake.ts`: Conversation intake — the shared ingress pipeline every adapter feeds. Owns the ordering `magic word → trigger policy → attachments → log → busy policy → queue → dispatch`, including the single cross-platform magic-word grammar (`matchMagicWord`; `stop` bypasses trigger policy and queueing). Returns an outcome (`magic-word | not-triggered | rejected-busy | enqueued`); adapters state platform policy as data (`magicWord.scopeFallback`, `busyPolicy`), not callbacks.
- `shared.ts`: Provides platform-shared retry, queueing, long-text splitting, message logging, stop-target resolution, and tool-argument formatting.
- `streaming.ts`: Buffered response streaming and ordered response operations shared by the response contexts.

## Subdirectories

- `discord/`: Discord bot implementation and Discord response context.
- `github/`: GitHub App polling bot (one issue/PR = one conversation), REST client, and response context.
- `slack/`: Slack bot, Slack session/thread rules, and Slack response context.
- `telegram/`: Telegram bot, Telegram HTML sanitization, and Telegram response context.
