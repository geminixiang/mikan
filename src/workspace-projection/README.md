# src/workspace-projection

Resolves what a conversation's sandbox sees of the host workspace: the conversation's effective workspace-mount mode and the concrete mount list.

## Files

- `index.ts`: `resolveWorkspaceProjection` maps a host workspace root plus conversation id to mounts — `full` mounts the whole workspace at `/workspace`; `private` mounts the shared support files (`MEMORY.md`, `skills/`, `events/`) plus only the conversation's own directory. `readWorkspaceProjectionMode` resolves the mode from conversation settings, falling back to the global default.
- `types.ts`: `WorkspaceProjection` — resolved mode plus container mounts.
