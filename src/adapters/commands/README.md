# src/adapters/commands

This directory contains chat command parsers, shared command types, and command handlers.

## Files

- `admin.ts`: Parses `/admin` and creates an admin portal login link.
- `auto-reply.ts`: Sets mention-free reply mode for one shared conversation — `off` (default), `on` (every message addresses mikan), or `jev` (Jev decides per message; see `harness/jev.ts`).
- `login.ts`: Handles `/login` and shared vault/profile commands, then creates login portal links.
- `manifest.ts`: The single command inventory. Platform adapters derive native registration and routing from it (Slack slash routes, Discord `commands.set`, Telegram menu), handler grammars derive their accepted spellings (`slashForms`), and session-view derives the bare `session` grammar (`commandForms`). Adding a command = one handler file + one manifest entry. Also owns command-text grammar: `matchCommand` (tokenization + alias matching for handlers) and `isCommandText` (recognition derived from the inventory; Conversation runtime injects it into `ChatHistorySync` to keep command messages out of replayed history).
- `model.ts`: Handles `/model provider/model[:thinking]` to show or switch conversation model settings.
- `new.ts`: Handles `/new` by resetting the current session in private conversations.
- `registry.ts`: Runs command handlers in order and stops after the first successful handler; builds the default handler list.
- `sandbox.ts`: Handles `/sandbox` status, boost, resource-limit queries, and `visibility <private|default>` — the admin escape hatch that narrows a public channel to private, written through `applyOfficeVisibility` so cached runners and disk stay in step.
- `session-view.ts`: Handles `/session` by creating a Session View portal link.
- `types.ts`: Defines command handler/context/services and token store interfaces.
- `utils.ts`: Provides command replies, diagnostic formatting, and private-conversation detection.
