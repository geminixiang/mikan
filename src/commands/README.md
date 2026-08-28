# src/commands

This directory contains chat command parsers, shared command types, and command handlers.

## Files

- `admin.ts`: Parses `/admin` and creates an admin portal login link.
- `auto-reply.ts`: Handles `/auto-reply` status, enable, and disable actions.
- `extensions.ts`: Handles `/extensions` by listing extensions loaded for the conversation.
- `login.ts`: Handles `/login` and shared vault/profile commands, then creates login portal links.
- `manifest.ts`: The single command inventory. Platform adapters derive native registration and routing from it (Slack slash routes, Discord `commands.set`, Telegram menu), handler grammars derive their accepted spellings (`slashForms`), and session-view derives the bare `session` grammar (`commandForms`). Adding a command = one handler file + one manifest entry. Also owns command-text grammar: `matchCommand` (tokenization + alias matching for handlers) and `isCommandText` (recognition derived from the inventory; session resume uses it to keep command messages out of replayed history).
- `model.ts`: Handles `/model provider/model[:thinking]` to show or switch conversation model settings.
- `new.ts`: Handles `/new` by resetting the current session in private conversations.
- `registry.ts`: Runs command handlers in order and stops after the first successful handler; builds the default handler list.
- `sandbox.ts`: Handles `/sandbox` status, boost, resource-limit queries, and `door <default|isolated|shared|shared-private|full>` — the chat control over the office's workspace door policy, written through `applyConversationWorkspacePolicy` so cached runners and disk stay in step.
- `session-view.ts`: Handles `/session` by creating a Session View portal link.
- `types.ts`: Defines command handler/context/services and token store interfaces.
- `utils.ts`: Provides command replies, diagnostic formatting, and private-conversation detection.
