---
title: Discord adapter
description: Configure Discord gateway intents, permissions, sessions, commands, attachments, and response behavior.
---

## Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. mikan requests this intent and cannot inspect ordinary message text without it.
3. Install the app with the `bot` and `applications.commands` scopes.
4. Grant the bot access required by the channels it will serve: View Channels, Send Messages, Read Message History, Add Reactions, Attach Files, Embed Links, and Send Messages in Threads.
5. Set the token and start mikan:

```bash
export DISCORD_BOT_TOKEN="..."
mikan /path/to/workspace
```

Channel permission overrides still apply. A successful installation does not guarantee access to every guild channel or private thread.

## Event sources and triggers

The adapter handles:

- `messageCreate` in DMs, guild channels, and Discord thread channels
- slash commands: `login`, `session`, `new`, `stop`, `model`, and `sandbox`
- message attachments

DMs trigger directly. Guild messages normally require a mention, a reply/thread context that mikan handles, or a matching auto-reply policy. Stop commands are checked before the normal trigger gate.

## Session rules

mikan uses `resolveChatSessionKey()` to isolate shared conversations:

| Scenario                  | Conversation/session identity                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| DM                        | conversation and session use the DM channel ID                                            |
| Guild top-level message   | conversation uses the channel ID; a triggered message is scoped by message ID             |
| Discord thread channel    | conversation uses the parent channel ID; session is `<parentChannelId>:<threadChannelId>` |
| Reply in a shared channel | session is scoped from the referenced/root message ID                                     |
| Slash command             | resolved from the interaction's channel/thread context                                    |

This prevents unrelated guild messages and threads from sharing agent context.

## Replies and attachments

The responder supports Discord Markdown, typing indicators, initial replies, incremental message edits, reply targets, reactions, and file uploads. Long output is split below Discord's message limit using a 1,900-character target.

Inbound attachments are downloaded into the conversation's `attachments/` directory with sanitized file names before the event reaches the runtime.

Guild slash-command acknowledgements are usually ephemeral; DM commands reply directly.

## Current boundaries

mikan does not treat voice, embeds, components, polls, or every Discord media/event type as agent input. Thread/channel visibility is limited by the app installation and channel permissions.
