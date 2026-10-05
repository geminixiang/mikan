# src/settings

Owner of `settings.json`: the global file in the state dir and the per-office
file in each office's host-only state directory. Everything that reads or
writes those files goes through this module; nothing else parses them.

## Ownership

| File       | Authority                                                                                                                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | Settings schema, normalization, scope merge (global → office), readers (`loadGlobalSettings`, `resolveConversationSettings`, `loadScopeMcpServers`, `loadOfficeVisibilityOverride`, …) and the raw writers (`updateGlobalSettings`, `updateConversationSettings`, `setOfficeVisibilityOverride`, …) |
| `apply.ts` | The one writer seam for settings that affect live conversations (`applyConversationSettings`, `applyGlobalSettings`, `applyOfficeVisibility`); chat commands and the Admin portal write through it so cached runners and disk never disagree                                                        |

## State directory

The global file is found through the caller's state dir: `office.workspace.stateDir` for office readers, an explicit `stateDir` argument for global-only readers and writers. Nothing here reads `STATE_DIR`/`MIKAN_STATE_DIR`; those are CLI inputs that `src/cli/arg-grammar.ts` resolves once at boot. An embedder that builds its own `Workspace` therefore gets its own `settings.json` and `models.json`, never `~/.mikan`'s. Pass `office.workspace.stateDir`, not `office.stateDir`, which is the office's own state directory.

## Scope rules

- Office settings override global settings key by key; `sandbox.boost` and `mcpServers` merge per entry, and an office entry with `disabled: true` suppresses an inherited MCP server.
- Office settings live at `conversationSettingsPath(office)` under the state dir, never inside the office's workspace directory, so sandboxed code cannot edit its own policy. `mikan migrate` moves a 0.5.3 in-workspace file there (`0003-conversation-settings`).
- Keys outside the schema, such as the retired `llm.autoReply` and `sandbox.image`, still parse so old files load, but nothing reads them and nothing rewrites them on disk. The daemon logs each file's ignored keys at startup (`findUnusedSettings`) so the operator removes them.
- Office visibility (`office.visibility`) has its own reader and writer rather than flowing through `AgentConfig`: it is a projection input (`src/office/projection.ts`), not an agent setting.

## Writer contract

Settings baked into a cached runner (model, thinking level, MCP servers, visibility) change only after the runtime has cleared or refused the cached runner; `apply.ts` performs the clear and the write in the same synchronous tick, and returns `{ ok: false }` instead of writing when the conversation is mid-turn. Other keys are re-read at use time and write directly.

Neighbors: `src/file-guards.ts` (schema-validated reads, atomic 0600 writes, state-dir placement guard), `src/env-manifest.ts` (environment variables, including `LINK_URL`), `src/office/` (office identity and the state directory the office file lives in).
