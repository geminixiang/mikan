# src/settings

Owner of `settings.json`: the global file in the state dir and the per-office
file in each office's host-only state directory. Everything that reads or
writes those files goes through this module; nothing else parses them.

## Files

| File         | Authority                                                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`   | Settings schema, normalization, scope merge (global → office), readers (`loadGlobalSettings`, `resolveConversationSettings`, `loadScopeMcpServers`, `loadOfficeVisibilityOverride`, …) and the raw writers (`updateGlobalSettings`, `updateConversationSettings`, `setOfficeVisibilityOverride`, …) |
| `apply.ts`   | The one writer seam for settings that affect live conversations (`applyConversationSettings`, `applyGlobalSettings`, `applyOfficeVisibility`); chat commands and the Admin portal write through it so cached runners and disk never disagree                                                        |
| `migrate.ts` | One-time settings migrations run by `mikan office …` with the daemon stopped (`migrateLegacyDoorPolicy`). Runtime code never imports this file                                                                                                                                                      |

## Scope rules

- Office settings override global settings key by key; `sandbox.boost` and `mcpServers` merge per entry, and an office entry with `disabled: true` suppresses an inherited MCP server.
- Office settings live at `conversationSettingsPath(office)` under the state dir, never inside the office's workspace directory, so sandboxed code cannot edit its own policy. Reading a legacy in-workspace file moves it there once and leaves a `{}` marker behind.
- Retired keys (`sandbox.image.workspaceMount`, `sandbox.workspace`) still parse so old files load, but are dropped from the resolved config; `migrate.ts` removes them from disk.
- Office visibility (`office.visibility`) has its own reader and writer rather than flowing through `AgentConfig`: it is a projection input (`src/office/projection.ts`), not an agent setting.

## Writer contract

Settings baked into a cached runner (model, thinking level, MCP servers, visibility) change only after the runtime has cleared or refused the cached runner; `apply.ts` performs the clear and the write in the same synchronous tick, and returns `{ ok: false, reason: "busy" }` instead of writing when the conversation is mid-turn. Other keys are re-read at use time and write directly.

Neighbors: `src/file-guards.ts` (schema-validated reads, atomic 0600 writes, state-dir placement guard), `src/env-manifest.ts` (environment variables, including `LINK_URL`), `src/office/` (office identity and the state directory the office file lives in).
