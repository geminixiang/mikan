---
title: Telegram adapter
description: Long polling, message updates, typing, file downloads, and session scope for the Telegram adapter.
---

## Main code

| File                               | Purpose                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/adapters/telegram/bot.ts`     | Telegram bot core: commands, message handler, attachments, file download, reply sending.      |
| `src/adapters/telegram/context.ts` | Creates the Telegram `ConversationResponder`; handles HTML mode, typing, and message updates. |
| `src/adapters/telegram/html.ts`    | Escapes / sanitizes Telegram HTML to avoid sending markup unsupported by Telegram.            |
| `src/adapters/telegram/types.ts`   | Telegram adapter-specific types.                                                              |

## Event sources

The Telegram adapter mainly handles:

- private chat messages
- group / supergroup messages
- commands: `/login`, `/session`, `/new`, `/stop`, `/model`
- reply messages
- photo / document attachments

Private chats trigger mikan directly. Groups require a mention, command, or matching auto-reply policy.

## Session rules

Telegram does not have Slack-style `thread_ts`. mikan builds scoped sessions from reply relationships:

| Telegram scenario       | session scope                        |
| ----------------------- | ------------------------------------ |
| Private chat            | chat session                         |
| Group top-level message | group chat session                   |
| Reply message           | scoped session from the reply target |

This lets different reply chains in the same group keep separate context.

## Replies and formatting

The Telegram adapter uses HTML parse mode, not Markdown. The adapter tells the agent to use:

- bold: `<b>text</b>`
- italic: `<i>text</i>`
- code: `<code>code</code>`
- pre: `<pre>code</pre>`
- link: `<a href="url">text</a>`

If Telegram reports an HTML parse error, the adapter falls back to escaped HTML before sending again.

## Attachments

The Telegram adapter supports photos and documents. Files are downloaded through the Telegram file API into `attachments/` in the workspace, then passed to the runtime.

## Stop behavior

`/stop` and the text `stop` are handled before the normal message trigger decision. If the current scoped session is running, it stops that session; otherwise, in groups, it tries to find the single scoped session that is currently running.
