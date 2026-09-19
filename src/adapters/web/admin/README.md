# src/adapters/web/admin

This directory provides the admin portal and admin token storage.

## Files

- `portal.ts`: Implements the `/admin` Web UI/API and its short-lived admin token store for conversations, models, sandbox, workspace door policy, MCP servers, skills (list, create, edit, delete for both global and conversation scope), events, and links.
- `provider-models.ts`: Resolves each catalog model's admin-facing access status (`available` / `unverified`) and the `provider/model` key the UI lists them under.
- `types.ts`: `AdminServices`, `AdminRuntimeBridge`, `EventSummary`, and the `AdminToken` record. The portal's conversation scope is an `OfficeAddress` and it reaches directories through the injected `Workspace`.
