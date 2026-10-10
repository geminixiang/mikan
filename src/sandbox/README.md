# src/sandbox

This directory defines sandbox configuration, the execution environments tools run in, managed container lifecycle, and shared sandbox utilities.

## Contracts

- `identity.ts` derives credential authorization keys and runtime resource keys separately, so neither can collide with the other.
- A backend without managed projection cannot enforce a private office's visibility; `warnUnenforcedPrivateOffice` in `registry.ts` logs that once per office and lets the run continue, because those backends are operator-selected trusted deployments.
- Managed image containers (`provisioner.ts`) are disposable (ADR 0014): only the bind mounts from the office projection and vault outlive them. A container with mount or network drift, or a stopped one whose image differs from the local tag's image ID, is replaced with `docker rm` + `docker run`. A running container is never replaced for an image change.
- `provision`, `stop`, and `remove` are serialized per key.
- A backend is accepted by its contract, not its technology: per-office environment isolation, adjustable resource limits, and a persistent workspace and vault, on Linux and macOS ([ADR 0022](../../docs/adr/0022-sandbox-contract-not-a-container-engine.md)). Today it is the `docker` CLI, which inherits mikan's environment, so the deployment picks the engine.
- A sandbox reaches tools only as Pi's `ExecutionEnv` (`@earendil-works/pi-durable/env`): `host` is Pi's `NodeExecutionEnv` and `container` is `ContainerExecutionEnv`. `image` has no environment of its own; the harness resolver provisions its container and then builds a `container` environment for it. A new backend implements `ExecutionEnv` and passes `registerEnvConformance`, as `src/test/container-execution-env.test.ts` does, instead of adding a mikan-specific interface.
- `ContainerExecutionEnv` does not offer `watch` (`not_supported`): no caller watches the sandbox, and polling would cost a `docker exec` per interval. Its `id` is `docker:<container>`, so Pi's edit and write queues serialize changes to one file across runs that share a container.
- Killing the host `docker exec` client does not stop the command inside the container. `ContainerExecutionEnv` therefore starts each command under `setsid` in its own process group and records the group ID with the leader's start time in `/tmp/mikan-exec-<uuid>` in the guest. An abort, a timeout, or `cleanup()` runs a second `docker exec` that kills that group. At startup, `reconcile` sweeps every running managed container the same way, ending commands a crashed process left behind; a container is never shared between two live mikan processes, so every recorded group there is an orphan. The start time check keeps a stale file from killing a reused process ID, and IDs at or below 1 are never signalled, because `kill -- -1` reaches every process. Dash needs `kill -s KILL -- -<group>` and BusyBox rejects `--`, so the scripts try both. An image without `setsid` still runs commands, but a stop leaves them running.

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
  workspace. `mikan migrate` moves 0.5.3 files out
  (`0003-conversation-settings`), and `conversationSettingsPath(office)` never
  reads the mounted location; malformed settings throw rather than falling
  back to a mounted copy.
- Startup refuses (fatal under sandboxed modes) a working directory that
  contains `~/.mikan` (`assertStateDirOutsideWorkspace`).
- Multi-instance hosts run each instance as its own user, because the state
  dir is that user's `~/.mikan`; conversation settings, auth, and vaults are
  keyed per state dir.

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
still declaring the retired `full` door policy get the same shape.

Only the managed `image:*` backend consumes and enforces these mount flags.
Host and existing-container modes ignore them and log once per
private office that its visibility is not enforced.

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

`ContainerExecutionEnv` runs every file operation as one `docker exec` of a
POSIX script; the guest needs a GNU or BusyBox userland (`stat -c`, `realpath`,
`truncate`, `mktemp`). File contents travel over stdin and stdout, never through
shell arguments, so they survive every quoting layer and stay under ARG_MAX.
Expected failures leave the script as exit statuses 70–74, which map to Pi's
`not_found`, `is_directory`, `not_directory`, `invalid`, and
`permission_denied`. Writes are staged beside the target and renamed, so an
interrupted write never truncates it. `openBinaryReader` reads the whole file
once and serves ranges from that snapshot, which keeps the bytes it opened
after a rename. A directory reader lists at its first page, so entries removed
after opening are not reported.

Commands run argv under `setsid` (see Contracts). An argv whose program is not
on the guest PATH exits 127 without output and is reported as `spawn_error`.
Output streams to `onOutput` as it arrives; past the spill thresholds it is
also piped into `<cwd>/.mikan/bash-output/<id>.log` in the guest.
