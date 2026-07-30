# src/sandbox

This directory defines sandbox abstractions, concrete sandbox executors, and shared sandbox utilities.

## Files

- `cloudflare.ts`: Implements the Cloudflare Sandbox bridge executor, argument parsing, health checks, and remote `/exec` calls.
- `container.ts`: Implements the Docker container executor, `docker exec` command construction, secure env files, and runtime bootstrap.
- `errors.ts`: Defines `SandboxError`, which can render user-facing CLI diagnostics.
- `firecracker.ts`: Implements the Firecracker VM executor by running commands over SSH inside the VM.
- `gondolin.ts`: Implements the single-host Gondolin microVM executor: per-conversation in-process VMs, file-mount projection and write-back, exec over the session IPC socket, desired-runtime fingerprinting and drift recreation, resource limits, idle lifecycle, and crash recovery.
- `host.ts`: Implements the host executor by running commands directly through the local shell.
- `identity.ts`: Separately derives collision-safe credential authorization keys and runtime resource keys.
- `image.ts`: Parses and validates `image:<image>` sandbox configs, which must later resolve to a concrete container executor.
- `index.ts`: Registers sandbox adapters and exposes parse, validate, and executor factory helpers, plus the per-adapter capability queries — `getSandboxCredentialCapabilities`, `getSandboxWorkspaceCapabilities`, and `assertSandboxSupportsWorkspacePolicy` (a backend without managed projection cannot honor an `isolated` door). `configureGondolinRuntime` is the one bootstrap seam an embedder calls before creating gondolin executors.
- `types.ts`: Defines all sandbox configs, executors, exec results, runtime path contexts, and adapter types.
- `utils.ts`: Provides simple child-process execution, process-tree killing, shell escaping, the shared base64-chunked file transport (`execReadFile`/`execWriteFile`) used by every exec-only executor, and `createMountedRuntimePathContext` (runtime→host path translation for mounted workspaces).

## Host / sandbox path boundary (image mode)

mikan's primary deployment is `image:*`: the mikan process (LLM calls, session
persistence, extensions, platform bots) runs on the **host**, while agent tool
commands execute inside a per-conversation **container**.

Host paths that belong to one conversation are keyed by its **office key**
(`v1-<platform>-<readable>-<16 hex>`, see `src/office/README.md`), not by the
raw platform conversation id — the same segment names the directory on the
host and inside the guest. Everything on disk belongs to exactly one of three
trust classes:

### Host-only — under the state dir (`~/.mikan`), never mounted

| Path                                                           | Contents                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`                                                | global settings                                                                                                                                               |
| `conversations/<office key>/settings.json`                     | conversation settings (model, door policy, …)                                                                                                                 |
| `auth.json`, `models.json`                                     | provider credentials and model catalog                                                                                                                        |
| `global/extensions/`, `conversations/<office key>/extensions/` | extension **code** (runs in the host process)                                                                                                                 |
| `global/`, `conversations/<office key>/`                       | extension code (`extensions/`), data (`extension-data/`), callback schedules (`extension-schedules/`), and packages (`git/`) per scope; see harness LAYOUT.md |
| `vaults/…`                                                     | credentials; the conversation vault key is the office key, and `vaults/extensions/<slug>/env` holds extension secrets                                         |
| `office-registry.json`                                         | the durable office journal (raw id ↔ office key; office keys are not reversible)                                                                              |

Rules enforced in code:

- Extension code loads only from the state dir (`defaultExtensionDirs`);
  loading from a mounted path would let sandboxed code run on the host.
- Conversation settings are read from the state dir only. They historically
  lived at `<office dir>/settings.json` — which is bind-mounted rw — so a
  sandboxed agent could widen its own door policy and remount the whole
  workspace. `conversationSettingsPath(office)` migrates legacy files once
  and never reads the mounted location again; malformed settings throw
  rather than falling back to the mounted copy.
- Startup refuses (fatal under sandboxed modes) a `--state-dir` located
  inside the working directory (`assertStateDirOutsideWorkspace`).
- Multi-instance hosts should give each instance its own `--state-dir`;
  conversation settings, auth, and vaults are keyed per state dir.

### Mounted read-write into the container — agent-writable by design

The mount set is chosen by the office's door policy, resolved in one place
(`resolveWorkspaceProjection`, `src/workspace-projection/README.md`):

| Mount                                       | Purpose                                       | Present in                      |
| ------------------------------------------- | --------------------------------------------- | ------------------------------- |
| `<office key>/` → `/workspace/<office key>` | sessions, attachments, scratch, office skills | every policy                    |
| `MEMORY.md` → `/workspace/MEMORY.md`        | agent-maintained workspace memory             | `trusted` + `shared-support`    |
| `skills/` → `/workspace/skills`             | agent-creatable workspace skills              | `trusted` + `shared-support`    |
| `events/` → `/workspace/events`             | event files (agent self-scheduling)           | `trusted` + `shared-support`    |
| vault mounts                                | per-user credential injection                 | every policy (when provisioned) |

`isolated` (the fresh-install default) mounts the office directory alone.
`trusted` + `full` (admin, or `/pi-sandbox door full`) mounts the entire
working directory at `/workspace` instead of the list above.

Changing the policy changes the container's desired mounts, which reads as
drift: the provisioner recreates the container with the new binds while
keeping its writable layer, so installed packages survive the switch. The
same translation carries containers across the raw-id → office-key rename.

### Mounted read-only into the container

| Mount                                                                        | Purpose                     |
| ---------------------------------------------------------------------------- | --------------------------- |
| `<scope>/git/<host>/<owner>/<repo>/skills` → `/mikan/packages/<slug>/skills` | skills shipped by a package |

`<scope>` is `global` or `conversations/<office key>`, both under the
host-only state dir. Package skills are the one thing the agent can see but
not write. The host owns those files — the directory is a git checkout that
an update replaces wholesale — so an agent edit would be silently discarded
on the next refresh; `ContainerMount.readOnly` makes the filesystem refuse it
instead (docker `:ro`, gondolin `ReadonlyProvider`). They mount **outside**
`/workspace` because under `trusted` + `full` `/workspace` is the whole
working directory and a `/workspace/packages` target would shadow a real
`packages/` directory. See `src/packages/README.md`.

Consequences to keep in mind:

- **Session files are agent-writable.** A corrupted session header makes
  `SessionStore.open` throw instead of silently starting a fresh session
  (which would erase history on the next append); `/new` recovers.
- **Extension `text` schedules are agent-visible and agent-tamperable**: they
  are event files in the shared events dir. Ownership prefixes are
  cooperative, not a security boundary — never put secrets in schedule text.
  Extension **callback** schedules are the deliberate opposite: a fire runs
  trusted host-side code, so they persist under the host-only state dir
  (`conversations/<office key>/extension-schedules/`) where the sandbox
  cannot reach them.
- **The events dir is a workspace-level scheduling bus — by design.** It is
  global and agent-writable, so any conversation's agent (or extension, or
  admin) can schedule runs in _any_ conversation. This is deliberate: one
  mikan workspace is one trust domain for scheduling, and cross-conversation
  events are exactly how PM-style workflows post reminders into other
  channels (e.g. agent-pm). Do not "fix" this by scoping events per
  conversation. Note it is only mounted under `trusted` + `shared-support`
  or `full`; an `isolated` office cannot self-schedule.
- Auto-reply config files live in the office dir and are therefore
  agent-toggleable (feature is deprecated).

### Paths in prompts and tool output

The model only ever sees **runtime** paths (`/workspace/…`); the host only
ever touches **host** paths. `createMountedRuntimePathContext` (`utils.ts`) translates between them
(skill locations, upload paths). Extension-shipped skills are the exception:
their files live under the host-only state dir, so their bodies are inlined
into the system prompt instead of referenced by path.

### File transport

`Executor.readFile`/`writeFile` own file content transport: the host
executor uses the filesystem directly; every exec-only executor (docker,
ssh, HTTP) shares the base64-chunked implementation in `utils.ts`, so file
contents never pass through shell argv, survive every quoting layer, stay
under per-argument ARG_MAX, and are staged + renamed so an aborted write
never truncates the target. Tools (write/edit, bash output spill) must use
these instead of composing `printf`/`cat` shell strings.
