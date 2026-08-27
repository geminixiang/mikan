# src/web/session-view

This directory provides the Session View command, Web UI, session model loading, and token storage.

## Files

- `portal.ts`: Provides the Session View Web UI, SSE live stream, interactive message submission, Markdown rendering, the short-lived token store, and the session→UI model loader (lineage follows `parentSessionId` ids rather than paths).
- `types.ts`: The parsed command, the UI item/relation/model shapes, and the `SessionViewToken` record.
