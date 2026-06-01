# src/session-view

This directory provides the Session View command, Web UI, session model loading, and token storage.

## Files

- `command.ts`: Parses `/session` and `/pi-session` commands.
- `portal.ts`: Provides the Session View Web UI, SSE live stream, interactive message submission, and Markdown rendering.
- `service.ts`: Loads Pi session JSONL into the UI model and infers parent/thread/related-session relationships.
- `store.ts`: Provides a short-lived in-memory Session View token store.
