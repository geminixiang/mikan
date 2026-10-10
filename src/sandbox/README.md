# src/sandbox

This directory defines sandbox configuration, the execution environments tools run in, managed container lifecycle, and shared sandbox utilities.

## Contracts

- `identity.ts` derives credential authorization keys and runtime resource keys separately, so neither can collide with the other.
- A backend without managed projection cannot enforce a private office's visibility; `warnUnenforcedPrivateOffice` in `registry.ts` logs that once per office and lets the run continue, because those backends are operator-selected trusted deployments.
- Managed image containers (`provisioner.ts`) are disposable (ADR 0014): only the bind mounts from the office projection and vault outlive them. A container with mount or network drift, or a stopped one whose image differs from the local tag's image ID, is replaced with `rm -f` and `run`. A running container is never replaced for an image change.
- `provision`, `stop`, and `remove` are serialized per key.
- A backend is accepted by its contract, not its technology: per-office environment isolation, adjustable resource limits, a persistent workspace and vault, and a workspace mounted from the host on the same machine, on Linux and macOS ([ADR 0022](../../docs/adr/0022-sandbox-contract-not-a-container-engine.md)). Today it is the docker command set, run by the first of `nerdctl`, `podman`, and `docker` whose `info` succeeds, detected once per process unless `CONTAINER_ENGINE` pins one (`engine.ts`). Containers belong to the engine that created them, so a host whose detected engine changes gets new containers and leaves the old ones behind. The provisioner uses only queries the three answer alike: `ps`/`network ls` name filters for existence, `.Mounts` for binds, mikan's `mikan.network` and `mikan.image-id` labels for network and image drift, and `--cpu-period`/`--cpu-quota` for CPU limits, because nerdctl ignores `update --cpus`, Podman reports binds with mount options and its network mode as `bridge`, and nerdctl reports `.Image` as a name. `src/test/container-provisioner-engine.test.ts` runs the provisioner against whichever engine is configured.
- A sandbox reaches tools only as Pi's `ExecutionEnv` (`@earendil-works/pi-durable/env`): `host` is Pi's `NodeExecutionEnv` and `container` is pi-env's `RemoteExecutionEnv` (`@earendil-works/pi-env`) talking to Pi's `pi-env` daemon inside the container. `image` has no environment of its own; the harness resolver provisions its container and then builds a `container` environment for it. A new backend implements `ExecutionEnv` and passes `registerEnvConformance`, as `src/test/container-execution-env.test.ts` does, instead of adding a mikan-specific interface.
- `createContainerExecutionEnv` (`container.ts`) keeps one pi-env connection per container for the whole process: `<engine> exec -i <container> /tmp/mikan-pi-env-<sha>`. Before each connection it readies the container and copies the packaged Linux daemon for the container's architecture to that path if it is missing, so a replaced or restarted container gets it again. Each run's environment readies its container once, through the resolver's provisioning, so drift is checked per run, and marks every operation as use for idle stopping. Its `id` is `container:<name>`, so Pi's edit and write queues serialize changes to one file across runs that share a container.
- The daemon runs each command in its own process group, kills it on abort, timeout, or `cleanup()`, and kills every group it started when its connection ends, so a crashed or stopped mikan leaves no command running. The agent can replace the daemon file in its own container, which gives it nothing it could not already run there; the host only parses the daemon's framed replies.

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

Every file operation and command is a request on the container's pi-env connection, so it costs one round trip on a pipe that stays open instead of starting a process. File contents and command output travel as framed bytes, never through shell arguments. Results follow Pi's `NodeExecutionEnv` on Linux, which is what the conformance suite checks, including `watch`. String commands run in the guest's `bash` when it has one, else `sh`; output past the spill thresholds is kept in a file under the guest's temp directory. Credentials reach commands as the environment's `shellEnv` in the request, never in argv or a host file.
