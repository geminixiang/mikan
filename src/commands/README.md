# src/commands

This directory contains chat command parsers, shared command types, and command handlers.

## Files

- `admin.ts`: Parses `/admin` and creates an admin portal login link.
- `auto-reply.ts`: Handles `/auto-reply` status, enable, and disable actions.
- `index.ts`: Re-exports command dispatch/types and builds the default command handler list.
- `login.ts`: Handles `/login` and shared vault/profile commands, then creates login portal links.
- `model.ts`: Handles `/model provider/model[:thinking]` to show or switch conversation model settings.
- `new.ts`: Handles `/new` by resetting the current session in private conversations.
- `parse.ts`: Provides generic command tokenization and prefix matching.
- `registry.ts`: Runs command handlers in order and stops after the first successful handler.
- `sandbox.ts`: Handles `/sandbox` status, boost, and resource-limit queries.
- `session-view.ts`: Handles `/session` by creating a Session View portal link.
- `types.ts`: Defines command handler/context/services and token store interfaces.
- `utils.ts`: Provides command replies, diagnostic formatting, and private-conversation detection.
