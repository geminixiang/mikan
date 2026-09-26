# src/sandbox

This directory defines sandbox abstractions, concrete sandbox executors, and shared sandbox utilities.

## Contracts

- `identity.ts` derives credential authorization keys and runtime resource keys separately, so neither can collide with the other.
- A backend without managed projection cannot honor an `isolated` door or read-only shared memory; `assertSandboxSupportsWorkspacePolicy` in `registry.ts` rejects that combination.
- Managed image containers (`provisioner.ts`) get a per-office home volume `mikan-home-<key>` at `/root` (ADR 0009). A home-volume container with mount or network drift, or a stopped one whose image differs from the local tag's image ID, is replaced with `docker rm` + `docker run` on the same volume. Legacy containers without a home volume keep the `docker commit` recreate path until `mikan sandbox migrate` moves them, and a `mikan-migrate:<name>` snapshot stays while its container still runs from it.
- `provision`, `stop`, `remove`, and `migrateToHomeVolume` are serialized per key. `remove` keeps the home volume unless `purgeHome` is set; office migration removes it.
- Exec-only executors share the base64-chunked file transport (`execReadFile` / `execWriteFile`) in `utils.ts`.

## Host / sandbox path boundary (image mode)

mikan's primary deployment is `image:*`: the mikan process (LLM calls, session
persistence, platform bots) runs on the **host**, while
agent tool commands execute inside a per-conversation **container**.

Host paths that belong to one conversation are keyed by its **office key**
(`v1-<platform>-<readable>-<16 hex>`, see `src/office/README.md`), not by the
raw platform conversation id — the same segment names the directory on the
host and inside the guest. Everything on disk belongs to exactly one of three
trust classes:

### Host-only — under the state dir (`~/.mikan`), never mounted

| Path                                       | Contents                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`                            | global settings                                                                                                                           |
| `conversations/<office key>/settings.json` | conversation settings (model, visibility override, …)                                                                                     |
| `models.json`                              | model catalog                                                                                                                             |
| `vaults/…`                                 | credentials; the conversation vault key is the office key. The legacy `vaults/extensions/` namespace remains reserved but is never loaded |
| `office-registry.json`                     | the durable office journal (raw id ↔ office key; office keys are not reversible)                                                          |

Rules enforced in code:

- Conversation settings are read from the state dir only. They historically
  lived at `<office dir>/settings.json` — which is bind-mounted rw — so a
  sandboxed agent could widen its own visibility and remount the whole
  workspace. `conversationSettingsPath(office)` migrates legacy files once
  and never reads the mounted location again; malformed settings throw
  rather than falling back to the mounted copy.
- Startup refuses (fatal under sandboxed modes) a `--state-dir` located
  inside the working directory (`assertStateDirOutsideWorkspace`).
- Multi-instance hosts should give each instance its own `--state-dir`;
  conversation settings, auth, and vaults are keyed per state dir.

### Workspace mounts

Every office receives the same mount shape (ADR 0008), resolved in one place
(`resolveWorkspaceProjection`, `src/office/README.md`); only the read-only
flags depend on the office's visibility:

| Mount                                            | Purpose                                                | Public office    | Private office   |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------- | ---------------- |
| `<office key>/` → `/workspace/<office key>`      | sessions, attachments, scratch, office skills          | rw               | rw               |
| `MEMORY.md` → `/workspace/MEMORY.md`             | agent-maintained workspace memory                      | rw               | ro               |
| `skills/` → `/workspace/skills`                  | agent-creatable workspace skills                       | rw               | ro               |
| `<other key>/` → `/workspace/public/<other key>` | every other public office; the only cross-office reach | ro               | ro               |
| vault mounts                                     | per-user credential injection                          | when provisioned | when provisioned |

Visibility follows the Slack conversation type: public channels are public;
private channels, DMs, group DMs, externally shared channels, and unknown kinds
are private. An operator may narrow a public channel with Admin or
`/pi-sandbox visibility private`. Nothing mounts the workspace root; offices
still declaring the retired `full` door policy get the same shape and are
reported once per process.

Only the managed `image:*` backend consumes and enforces these mount flags.
Host, existing-container, and Cloudflare modes fail closed when a projection
requires isolation or read-only shared memory.

Changing the policy changes the container's desired mounts, which reads as
drift: the provisioner recreates the container with the new binds while
keeping its writable layer, so installed packages survive the switch. The
same translation carries containers across the raw-id → office-key rename.
The recreate log names the first drift found: `binds`, `mount-content`, or
`network`.

Guest paths (`/workspace`, `/workspace/public`, `/root`) come from
`layout.ts`.

Consequences to keep in mind:

- **Session files are agent-writable.** A corrupted session header makes
  `SessionStore.open` throw instead of silently starting a fresh session
  (which would erase history on the next append); `/new` recovers.
- **The events dir is a workspace-level scheduling bus — by design.** It is
  host-only per office (`conversations/<office key>/events/`) and never
  mounted; the `event` tool is the only agent path and reaches only the
  current office. Event text is agent-visible and must never contain secrets.
- Retired auto-reply marker files are inert and are not deleted when settings are read.

### Paths in prompts and tool output

The model only ever sees **runtime** paths under `/workspace`; the host only
ever touches **host** paths. `createMountedRuntimePathContext` (`utils.ts`)
translates between them for skill locations and upload paths.

### File transport

`Executor.readFile`/`writeFile` own file content transport: the host
executor uses the filesystem directly; every exec-only executor (docker,
ssh, HTTP) shares the base64-chunked implementation in `utils.ts`, so file
contents never pass through shell argv, survive every quoting layer, stay
under per-argument ARG_MAX, and are staged + renamed so an aborted write
never truncates the target. Tools (write/edit, bash output spill) must use
these instead of composing `printf`/`cat` shell strings.
