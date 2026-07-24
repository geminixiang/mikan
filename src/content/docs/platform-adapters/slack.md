---
title: Slack adapter
description: Socket Mode events, thread routing, Block Kit, and response lifecycle for the Slack adapter.
---

## Main code

| File                                       | Purpose                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot core: Socket Mode events, slash commands, Block Kit actions, file download, message sending.    |
| `src/adapters/slack/context.ts`            | Creates the Slack `ConversationResponder`; handles mrkdwn, reply modes, working state, and long messages. |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key rules.                                                                   |
| `src/adapters/slack/response-lifecycle.ts` | Slack response lifecycle and streaming updates.                                                           |
| `src/adapters/slack/tools/*`               | Slack-specific tools such as attachment and Block Kit support.                                            |

## Event sources

The Slack adapter mainly handles:

- `app_mention`
- `message`
- slash commands: `/pi-login`, `/pi-session`, `/pi-model`, `/pi-auto-reply`, `/pi-new`, etc.
- Block Kit actions
- assistant thread / status APIs

DMs trigger mikan directly. Shared-channel messages require a mention, interaction, or matching auto-reply policy. An ordinary unmentioned human reply in a channel thread is logged but does not trigger a run; thread session isolation does not bypass the trigger policy.

## Session rules

Slack has explicit channel and thread models, so session keys are separated accordingly:

| Slack scenario            | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

This lets channel conversations and thread conversations keep separate session contexts.

## Replies and formatting

The agent writes standard Markdown/GFM (the platform-neutral response source). The adapter renders it through Slack's native `markdown` block, so Slack itself translates the Markdown — bold, italic, strikethrough, inline and fenced code, links, nested lists, and blockquotes — into rich text. Legacy Slack-style `<url|label>` links are converted to `[label](url)` before rendering. Markdown pipe tables render as native Slack table blocks.

The Slack adapter also supports:

- top-level or thread reply mode
- working / assistant status
- updating existing replies to show streaming progress
- Block Kit rendering for headings, paragraphs, lists, code fences, and tables
- file uploads

Block Kit output follows Slack limits: prose is split into `markdown` blocks of at most 12,000 characters at paragraph boundaries, table cells are truncated around 2,000 characters, and a message is capped at 50 blocks. Use file output for very large structured results.

## Attachments

Slack file attachments are downloaded to the conversation attachment directory in the workspace, then passed to the runtime as shared mikan attachment metadata.

## Stop behavior

`stop` / `/stop` first stops the current thread session. If used at top level in a channel, the adapter uses the current running sessions to decide whether it can safely stop the matching session.
