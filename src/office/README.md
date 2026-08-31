# office

The Conversation office module. An office is one conversation's persistent
working area and data boundary (CONTEXT.md); this module owns its identity,
its host-side directory layout, its durable record, and the legacy migration.

## Files

- `index.ts`: The whole module in one file, in four sections.
  - **Identity**: `OfficeAddress` is `platform` plus the platform's raw
    `conversationId`; raw ids stay at platform I/O boundaries. Storage paths
    use the versioned `OfficeKey` (`v1-<platform>-<readable>-<16 hex>`),
    whose digest is SHA-256 over both values (ADR 0005) — the readable
    middle is a hint, the digest is the authority.
    `officeStateDir(stateDir, address)` is the one path helper exported for
    stateDir-only surfaces that hold no Office value: CLI subcommands and
    package materialization. `officeDir` is
    module-internal, because callers outside `src/office/` use `Office.dir`.
  - **Layout**: `createWorkspace({root, stateDir})` builds the per-process
    `Workspace` (workspace-global paths, reserved-name set, office factory);
    `workspace.office(address)` returns the memoized, frozen `Office` (key,
    dir, subpaths, host state dir, `ensure()`). `Office.ensure()` is the
    single materialization seam: it records the office in the registry
    before creating the directory, so the registry stays the durable
    raw-id ↔ office mapping (office keys are not reversible). The registry
    instance and recorded-office cache live on the Workspace value — there
    is no process-wide registry state.
  - **Registry**: `OfficeRegistry`, the host-only journal
    (`office-registry.json` in the state dir): enabled platforms, office
    records, and crash-safe legacy-migration transitions under a domain
    lease. Plus the cold-path `listRegisteredOffices` lookup used by Admin enumeration.
  - **Migration**: The every-boot legacy migration: raw-id workspace dirs,
    conversation vault keys, and per-conversation host state trees move to
    the office-key layout, journaled prepare → moving → committed with
    crash recovery. Unowned dirs fail boot until `mikan office claim` names
    an owner. Also the container bind translator that lets managed
    containers survive the rename with writable layers intact.
- `types.ts`: The exported `Workspace`/`Office` interfaces.

## Consumers

Runtime consumers are switched: session state, vaults, per-conversation host
state, and Admin scope are all office-keyed (ADR 0005). Platform adapters
keep raw ids at their external I/O boundaries, and sandbox resource names
stay raw-derived until the resource-naming migration.

The `Office` value is the argument, not a bag of derived strings: option
objects that used to carry a workspace root plus a conversation id plus a
state dir now carry one `office` field, and callers read `office.dir`,
`office.key`, `office.stateDir` from it. The main crossings:

| Consumer               | Entry point                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| conversation settings  | `conversationSettingsPath(office)`, `resolveConversationSettings(office)` (`src/config.ts`)    |
| workspace projection   | `resolveWorkspaceProjection(office)` (`src/workspace-projection/`)                             |
| packages               | `ResolvePackagesOptions {office, fetchMissing?}`, `PackageAdminContext {office, runtime?}`     |
| conversation vault     | vault key = `officeKey(address)` (`src/vault/`)                                                |
| chat log + attachments | `appendChannelLog(office, …)`, `saveIncomingAttachments(office, …)` (`src/adapters/shared.ts`) |

`officeStateDir(stateDir, address)` covers the surfaces that genuinely hold
no Office (CLI subcommands and package materialization).
