---
title: Slack adapter
description: Socket Mode events, thread routing, Block Kit, and response lifecycle for the Slack adapter.
---

## Main code

| File                                       | Purpose                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `src/adapters/slack/bot.ts`                | Slack bot core: Socket Mode events, slash commands, Block Kit actions, file download, message sending. |
| `src/adapters/slack/blocks.ts`             | Markdown → native Slack blocks, and `<@userName>` → `<@U…>` mention resolution.                        |
| `src/adapters/slack/context.ts`            | Creates the Slack `ConversationResponder`; handles reply modes, working state, and long messages.      |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key rules.                                                                |
| `src/adapters/slack/response-lifecycle.ts` | Slack response lifecycle and streaming updates.                                                        |
| `src/adapters/slack/tool-pack.ts`          | The Slack tool pack injected into the runtime.                                                         |
| `src/adapters/slack/tools/*`               | Slack-specific tools such as attachment and Block Kit support.                                         |

## Event sources

The Slack adapter mainly handles:

- `app_mention`
- `message`
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
- Slack's native streaming API (`chat.startStream` / `appendStream` / `stopStream`) as well as edit-based progress updates
- Block Kit rendering for headings, paragraphs, lists, code fences, and tables
- file uploads

Block Kit output follows Slack limits: prose is split into `markdown` blocks of at most 12,000 characters at paragraph boundaries, table cells are truncated around 2,000 characters, and a message is capped at 50 blocks. Use file output for very large structured results.

## Mentions

The response source is platform-neutral, so the model writes `<@userName>` using the names from the prompt's Users table. The adapter converts those to Slack's native `<@U…>` form on every outgoing path — new messages, edits, and stream deltas alike — because Slack only links and notifies on the raw user id. Lookup covers `userName` and `displayName` case-insensitively, a display name never shadows someone else's `userName`, already-native ids pass through, and an unknown name is left verbatim rather than guessed at. A mention split across two stream deltas stays unresolved in that delta and is resolved by the final canonical render.

## Attachments

Slack file attachments are downloaded into the conversation office's `attachments/` directory as `<timestamp>_<sanitized-name>`, then passed to the runtime as shared mikan attachment metadata with an office-relative path. This is the same shared helper every adapter uses; the Slack adapter contributes only the download call.

## Stop behavior

`stop` / `/stop` first stops the current thread session. If used at top level in a channel, the adapter uses the current running sessions to decide whether it can safely stop the matching session.
