# src/adapters/commands

This directory contains chat command parsers, shared command types, and command handlers.

## Contracts

- `manifest.ts` is the single command inventory. Slack slash routes, Discord `commands.set`, and the Telegram menu derive from it; handler grammars derive their accepted spellings (`slashForms`), and Session View derives the bare `session` grammar (`commandForms`). Adding a command means one handler file plus one manifest entry.
- `matchCommand` and `isCommandText` own command-text grammar. Conversation runtime injects `isCommandText` into `ChatHistorySync` so command messages stay out of replayed history.
- `registry.ts` runs handlers in order and stops at the first one that handles the message.
- Commands that change live settings (`/model`, `/sandbox visibility`) write through `src/settings/apply.ts`, so cached runners and disk stay in step.
