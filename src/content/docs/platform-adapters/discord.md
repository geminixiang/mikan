---
title: Discord adapter
description: Event intake, session scope, slash commands, and message response flow for the Discord adapter.
---

## Main code

| File                              | Purpose                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/adapters/discord/bot.ts`     | Discord bot core: message events, slash commands, attachments, channel lookup, reply sending.      |
| `src/adapters/discord/context.ts` | Creates the Discord `PlatformResponder`; handles Markdown, typing indicators, and message updates. |
| `src/adapters/discord/types.ts`   | Discord adapter-specific types.                                                                    |

## Event sources

The Discord adapter mainly handles:

- `messageCreate`
- slash commands: `login`, `session`, `new`, `stop`, `model`, `sandbox`
- DM, guild channel, and thread channel messages
- message attachments

DMs trigger mikan directly. Guild channels usually require a mention, thread reply, or matching auto-reply policy.

## Session rules

The Discord adapter uses the shared `resolveChatSessionKey()` to compute sessions:

| Discord scenario                | session scope                    |
| ------------------------------- | -------------------------------- |
| DM                              | DM conversation                  |
| Guild channel top-level message | channel conversation             |
| Thread channel or reply         | scoped session                   |
| Slash command                   | session from interaction context |

This keeps Discord threads and normal channel conversations from contaminating each other's context.

## Replies and formatting

The Discord response context handles:

- Discord Markdown
- typing indicators
- initial replies and later message updates
- reply targets, meaning replies to the original message
- long message splitting

Slash commands in guilds usually use ephemeral responses; in DMs they reply directly to the user.

## Attachments

Discord attachments are downloaded to `attachments/` in the workspace. File names are lightly sanitized before being passed to the runtime.

## Stop behavior

`stop` / `/stop` is handled before the trigger gate, so stop commands are not blocked by auto-reply policy. The adapter uses the session key and current running sessions to find the session to stop.
