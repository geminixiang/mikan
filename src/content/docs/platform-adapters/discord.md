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

## Slash-command registration

The adapter does not keep its own command inventory. On connect it registers every
`src/commands/manifest.ts` entry marked for Discord through `application.commands.set()`, taking the
name, description, and optional string argument straight from the entry. Adding a command therefore
means adding a manifest entry, not editing the adapter.

Discord rejects a registration whose command or option description exceeds 100 characters, and the
whole `set()` call fails — which would silently leave the guild with a stale command list until the
next restart. A unit test enforces the 100-character budget on every manifest description so that
failure surfaces at test time instead.

## Session rules

mikan uses `resolveChatSessionKey()` to isolate shared conversations. Discord passes
`persistentTopLevel: true`, so a channel's top-level conversation keeps one durable session instead
of forking a new one per triggering message:

| Scenario                 | Conversation id   | Session key                             |
| ------------------------ | ----------------- | --------------------------------------- |
| DM                       | DM channel ID     | the same DM channel ID                  |
| Guild top-level message  | channel ID        | the same channel ID                     |
| Discord thread channel   | parent channel ID | `<parentChannelId>:<threadChannelId>`   |
| Reply in a guild channel | channel ID        | `<channelId>:<referencedMessageId>`     |
| Slash command            | same as above     | resolved from the interaction's context |

So threads and replies fork their own session, while ordinary channel chatter continues the
channel's persistent one. A reply scopes to the message it directly references, not to a thread
root that Discord does not provide for plain channel replies. DM replies are the exception: a DM is
already a private conversation, so it stays on the bare channel key rather than forking per reply.

## Replies and attachments

The responder supports Discord Markdown, typing indicators, initial replies, incremental message edits, reply targets, reactions, and file uploads. Long output is split below Discord's message limit using a 1,900-character target.

Inbound attachments are downloaded into the conversation office's `attachments/` directory as `<timestamp>_<sanitized-name>` before the event reaches the runtime, through the same shared helper the other adapters use.

Guild slash-command acknowledgements are usually ephemeral; DM commands reply directly.

## Current boundaries

mikan does not treat voice, embeds, components, polls, or every Discord media/event type as agent input. Thread/channel visibility is limited by the app installation and channel permissions.
