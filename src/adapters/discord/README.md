# src/adapters/discord

This directory implements the Discord platform adapter.

## Behavior notes

- Slash commands are registered from `src/adapters/commands/manifest.ts` at ready time
  (`COMMAND_MANIFEST.filter((entry) => entry.discord)`), so a command exists on
  Discord by being in the manifest — there is no second list here. Discord caps
  command and option descriptions at 100 characters and rejects the whole
  registration call when one is over, which fails silently until the next
  restart; `commands.test.ts` enforces that budget on the manifest.
- Session scope: a guild channel's top-level messages share the persistent
  conversation session; a message in a Discord thread scopes to the parent
  channel plus the thread id, and a reply scopes to the referenced message. DMs
  are always one persistent session.
