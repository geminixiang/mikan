# office

The Conversation office module. An office is one conversation's persistent
working area and data boundary (CONTEXT.md); this module owns its identity,
its host-side directory layout, its durable record, and the legacy migration.

## Files

- `address.ts`: Canonical identity. `OfficeAddress` is `platform` plus the
  platform's raw `conversationId`; raw ids stay at platform I/O boundaries.
  Storage paths use the versioned `OfficeKey`, derived by SHA-256 from both
  values (ADR 0005). `officeStateDir(stateDir, address)` remains the one
  low-level path helper, for stateDir-only surfaces (CLI, extension loader,
  package materialization) that hold no Office value.
- `layout.ts`: The two layout values. `createWorkspace({root, stateDir})`
  builds the per-process `Workspace` (workspace-global paths, reserved-name
  set, office factory); `workspace.office(address)` returns the memoized,
  frozen `Office` (key, dir, subpaths, host state dir, `ensure()`).
  `Office.ensure()` is the single materialization seam: it records the
  office in the registry before creating the directory, so the registry
  stays the durable raw-id ↔ office mapping (office keys are not
  reversible). The registry instance and recorded-office cache live on the
  Workspace value — there is no process-wide registry state.
- `registry.ts`: `OfficeRegistry`, the host-only journal
  (`office-registry.json` in the state dir): enabled platforms, office
  records, and crash-safe legacy-migration transitions under a domain lease.
  Plus the cold-path raw-id lookups (`resolveOwnedOfficeAddress` for CLI
  operators, `listRegisteredOffices` for Admin enumeration).
- `migration.ts`: The every-boot legacy migration: raw-id workspace dirs,
  conversation vault keys, and per-conversation host state trees move to the
  office-key layout, journaled prepare → moving → committed with crash
  recovery. Unowned dirs fail boot until `mikan office claim` names an
  owner. Also the container bind translator that lets managed containers
  survive the rename with writable layers intact.

## Consumers

Runtime consumers are switched: session state, vaults, per-conversation host
state, and Admin scope are all office-keyed (ADR 0005). Platform adapters
keep raw ids at their external I/O boundaries, and sandbox resource names
stay raw-derived until the resource-naming migration.
