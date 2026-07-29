# src/web/session-view

This directory provides the Session View command, Web UI, session model loading, and token storage.

## Files

- `command.ts`: Parses the `session` command, accepting the spellings the command manifest declares (`commandForms("session")`) rather than a hard-coded list.
- `portal.ts`: Provides the Session View Web UI, SSE live stream, interactive message submission, and Markdown rendering.
- `service.ts`: Loads a harness session's JSONL into the UI model and walks lineage — a thread session's `parentSessionId` resolves to the main session it branched from, so relationships follow ids rather than paths.
- `store.ts`: Provides a short-lived in-memory Session View token store.
- `types.ts`: The parsed command, the UI item/relation/model shapes, and the `SessionViewToken` record.
