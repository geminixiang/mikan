---
status: accepted
---

# Office Address is the future canonical conversation identity

A conversation office is identified internally by its platform and raw platform
conversation ID. `src/office-address.ts` derives a versioned, filesystem-safe
`OfficeKey` from both values; the readable part is diagnostic only and the
SHA-256 digest is the collision-resistant identity component.

The normalized conversation event/message seam now carries `OfficeAddress`, and every production platform or synthetic intake validates the compatibility raw ID against it. Runtime session state (runner cache, queues, barriers, busy/stop checks) is addressed by office plus the office's platform session reference: every session-scoped `MessagingEventHandler` call carries the `OfficeAddress`, so two platforms sharing a raw conversation ID can never select each other's runtime state. The session-key grammar itself stays a raw platform value.

Workspace office directories use the office-key layout: `officeDirName` names the same segment on the host and inside sandbox runtimes, and `ensureOfficeDir` is the single materialization seam — it records the office in the registry before creating the directory, so the registry stays the durable raw-ID ↔ office mapping (office keys are not reversible). Every boot runs the office migration: legacy raw-ID directories are journaled prepare → moving → rename → committed with crash recovery; a single enabled platform claims them automatically, several enabled platforms fail boot until `mikan office claim <id> <platform>` assigns owners, and image-mode containers for migrated conversations are recreated so their mounts follow the new paths. Session Dream write grants target the office-key memory path.

Conversation-scoped credential vaults are keyed by office key — the same string that names the office in the workspace and the registry — so platforms sharing a raw conversation ID can never resolve each other's credentials. The boot migration renames legacy raw-ID vault directories using the registry inventory and fails closed on conflicts. Host-mode vaults stay user-keyed (the host has no execution isolation to scope to) and container mode stays container-keyed.

Per-conversation host state (`<state-dir>/conversations/<officeKey>` — settings.json, extensions, extension-data, git checkouts) is office-keyed: the settings scope and the extension/package APIs carry the `OfficeAddress`, and the boot migration moves each office's whole legacy tree in one rename, failing closed on conflicts. The event tool's conversation scope matches platform as well as raw ID (platform-less legacy files stay visible); the events directory itself remains the workspace-wide scheduling bus by design.

Sandbox resource keys (container names, gondolin instances, cloudflare scopes) stay raw-conversation-derived until the resource-naming migration — a collision there costs a container recreate, never credential access. Admin scope is still raw-ID keyed; its surfaces resolve offices through the registry (`resolveOwnedOfficeAddress`), which refuses ambiguous IDs shared by several platforms until Admin carries full addresses.

Platform adapters continue to use raw IDs at their external I/O boundaries.
The registry never infers a platform from an ID prefix: one enabled platform may
claim an unowned legacy directory, while multiple enabled platforms require an
explicit owner.
