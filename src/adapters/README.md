# src/adapters

This directory contains chat platform adapters and shared adapter helpers.

Every adapter is constructed with a `Workspace` and reaches per-conversation
state through an `Office` resolved from a typed `OfficeAddress` (see
`src/office/`), which each intake carries on its event — no adapter takes a raw
conversation directory path. Every built-in adapter implements the shared
`MessagingBot.stop()` lifecycle boundary: Slack disconnects Socket Mode,
Discord destroys its client, Telegram stops polling, and GitHub clears polling
and webhook-debounce timers while waiting for an active poll to finish. Process
shutdown begins closing these external paths first and gives their accepted work
a bounded 30-second drain window. Conversation runtime closes after a successful
drain; on timeout it aborts stuck runner construction and the process reports a
failed shutdown.

## Files

- `intake.ts`: Conversation intake — the shared ingress pipeline every adapter feeds. Owns the ordering `magic word → trigger policy → attachments → log → busy policy → queue → dispatch`, including the single cross-platform magic-word grammar (`matchMagicWord`; `stop` bypasses trigger policy and queueing). Returns an outcome (`magic-word | not-triggered | rejected-busy | enqueued`); adapters state platform policy as data (`magicWord.scopeFallback`, `busyPolicy`), not callbacks.
- `shared.ts`: The shared adapter surface — retry, queueing, long-text splitting, stop-target resolution, tool-argument formatting, and the two office write paths every adapter funnels through: `appendChannelLog(office, entry)` for `log.jsonl` and `saveIncomingAttachments(office, items)` for incoming platform files. The latter owns the whole attachment convention (sanitized `<timestamp>_<name>` under the office's attachments dir, office-relative `localPath`, results in caller order); download mechanics and failure policy stay with each adapter.
- `progressive-renderer.ts`: The single response state owner. It serializes response operations, accumulates source text, manages working indicators and typing, owns response identity, splits long output, and coordinates buffered or native stream transports. Platform contexts provide only transport and rendering policy.
- `types.ts`: The adapter type surface — intake options and outcome, the progressive-renderer platform contract, retry/stop-target inputs, incoming/saved attachment shapes, and chat-response error context.

## Subdirectories

- `discord/`: Discord bot implementation and Discord response context.
- `github/`: GitHub App polling bot (one issue/PR = one conversation), REST client, and response context.
- `slack/`: Slack bot, Slack session/thread rules, native Block Kit rendering, and Slack response context.
- `telegram/`: Telegram bot, Telegram HTML sanitization, and Telegram response context.
