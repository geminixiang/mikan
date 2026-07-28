# src/workspace-projection

Resolves one conversation office's complete data view: the effective door policy, concrete runtime mounts, and the host-side memory/skill sources authorized for prompt construction. Keeping those outputs together prevents the prompt from bypassing filesystem isolation.

## Policies

- `isolated` (fresh-install default): mounts only the current conversation directory and authorizes only conversation memory/skills.
- `trusted` + `shared-support`: preserves the former `private` behavior by mounting shared `MEMORY.md`, `skills/`, `events/`, and the conversation directory.
- `trusted` + `full`: mounts the whole workspace.

Legacy `sandbox.image.workspaceMount` values remain readable: `private` maps to trusted/shared-support and `full` maps to trusted/full. New configuration is backend-neutral under `sandbox.workspace`.

## Files

- `index.ts`: `resolveWorkspaceProjection` is the single office-data policy seam. It normalizes canonical and legacy settings, safely materializes required roots, rejects wrong types/symlinks, and returns runtime mounts plus authorized prompt sources.
- `types.ts`: Defines the resolved projection and prompt-source contract.
