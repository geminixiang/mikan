---
title: Telegram adapter
description: Configure BotFather privacy, long polling, reply-scoped sessions, commands, files, and HTML responses.
---

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Keep BotFather privacy mode enabled unless another explicit integration needs ordinary group messages. Privacy mode limits group delivery; disabling it with `/setprivacy` does not make mikan respond to unaddressed messages.
3. Add the bot to each group and grant only the group/admin permissions needed to read and send messages or files.
4. Set the token and start mikan:

```bash
export TELEGRAM_BOT_TOKEN="..."
mikan /path/to/workspace
```

mikan uses long polling; no public Telegram webhook is required.

## Event sources and triggers

The adapter handles:

- private, group, and supergroup messages
- `/login`, `/session`, `/new`, `/stop`, `/model`, `/sandbox`, and `/admin` — the command menu is registered from `src/adapters/commands/manifest.ts` through `setMyCommands`, so it never drifts from the shared inventory
- replies, photos, and documents

Private messages trigger directly. Group messages require an addressed command, mention, or supported reply context. Telegram must first deliver the message to the bot; broader delivery does not bypass the explicit trigger gate.

## Session rules

Telegram has no Slack-style `thread_ts`. mikan derives scope from the immediate reply relationship:

| Scenario                          | Session identity                 |
| --------------------------------- | -------------------------------- |
| Private chat                      | chat ID                          |
| Triggered group top-level message | `<chatId>:<messageId>`           |
| Reply                             | `<chatId>:<referencedMessageId>` |

Nested replies therefore follow the referenced message IDs rather than a platform-provided durable thread root. Telegram forum-topic `message_thread_id` is not currently a separate documented session dimension.

## Replies and attachments

Responses use Telegram HTML mode. Supported formatting includes `<b>`, `<i>`, `<code>`, `<pre>`, and `<a href="...">`. If Telegram rejects generated markup, mikan retries with escaped HTML. The responder also supports typing status, message edits, reply targets, and file uploads.

Inbound photos and documents are downloaded through Telegram's file API into the conversation office's `attachments/` directory as `<timestamp>_<sanitized-name>`, through the same shared helper the other adapters use. Other media types such as voice, audio, video, stickers, and polls are not handled as equivalent inbound attachments.

## Stop behavior

`/stop` and text `stop` are handled before the normal trigger decision. mikan first targets the current scoped session; in a group, it can fall back to the only currently running scoped session when that choice is unambiguous.
