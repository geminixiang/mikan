---
title: Slack adapter
description: Socket Mode events, thread routing, Block Kit, and response lifecycle for the Slack adapter.
---

## Main code

| File                                       | Purpose                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/adapters/slack/bot.ts`                | Slack bot core: Socket Mode events, slash commands, Block Kit actions, file download, message sending. |
| `src/adapters/slack/context.ts`            | Creates the Slack `PlatformResponder`; handles mrkdwn, reply modes, working state, and long messages.  |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key rules.                                                                |
| `src/adapters/slack/response-lifecycle.ts` | Slack response lifecycle and streaming updates.                                                        |
| `src/adapters/slack/tools/*`               | Slack-specific tools such as attachment and Block Kit support.                                         |

## Event sources

The Slack adapter mainly handles:

- `app_mention`
- `message`
- slash commands: `/pi-login`, `/pi-session`, `/pi-model`, `/pi-auto-reply`, `/pi-new`, etc.
- Block Kit actions
- assistant thread / status APIs

DMs trigger mikan directly. Messages in channels usually require a mention or a matching auto-reply policy.

## Session rules

Slack has explicit channel and thread models, so session keys are separated accordingly:

| Slack scenario            | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

This lets channel conversations and thread conversations keep separate session contexts.

## Replies and formatting

Slack uses mrkdwn, not regular Markdown. The adapter's platform formatting guide tells the agent to use:

- bold: `*text*`
- italic: `_text_`
- code: `` `code` ``
- block: three backticks
- link: `<url|text>`

The Slack adapter also supports:

- top-level or thread reply mode
- working / assistant status
- updating existing replies to show streaming progress
- Block Kit rendering
- file uploads

## Attachments

Slack file attachments are downloaded to the conversation attachment directory in the workspace, then passed to the runtime as shared mikan attachment metadata.

## Stop behavior

`stop` / `/stop` first stops the current thread session. If used at top level in a channel, the adapter uses the current running sessions to decide whether it can safely stop the matching session.
