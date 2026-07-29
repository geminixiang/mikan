# src/workspace-projection

Resolves one conversation office's complete data view: the effective door policy, concrete runtime mounts, and the host-side memory/skill sources authorized for prompt construction. Keeping those outputs together prevents the prompt from bypassing filesystem isolation.

## Policies

A projection is a door policy (`isolated` / `trusted`) paired with a layout
(`conversation` / `shared-support` / `full`). The office directory always
mounts at `/workspace/<office key>`, so the guest path is identical across
policies.

- `isolated` (fresh-install default) → layout `conversation`: mounts only the office directory and authorizes only that office's memory/skills.
- `trusted` + `shared-support`: preserves the former `private` behavior by also mounting shared `MEMORY.md`, `skills/`, and `events/`.
- `trusted` + `full`: mounts the whole workspace root at `/workspace`.

`isolated` forces layout `conversation`; a layout is only honored under
`trusted`. Legacy `sandbox.image.workspaceMount` values remain readable:
`private` maps to trusted/shared-support and `full` maps to trusted/full.
New configuration is backend-neutral under `sandbox.workspace`.

Chat operators change it with `/pi-sandbox door <default|isolated|shared|full>`
(`src/commands/sandbox.ts`), which writes through the settings-mutation seam.

## Files

- `index.ts`: `resolveWorkspaceProjection(office)` is the single office-data policy seam. It normalizes canonical and legacy settings, safely materializes required roots, rejects wrong types/symlinks, and returns door policy, layout, runtime mounts, and authorized prompt sources. Malformed settings throw rather than falling back — settings are host-authoritative, so an unreadable file must never degrade into a wider mount.
- `types.ts`: Defines the resolved projection and prompt-source contract.
