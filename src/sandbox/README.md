# src/sandbox

This directory defines sandbox abstractions, concrete sandbox executors, and shared sandbox utilities.

## Files

- `cloudflare.ts`: Implements the Cloudflare Sandbox bridge executor, argument parsing, health checks, and remote `/exec` calls.
- `container.ts`: Implements the Docker container executor, `docker exec` command construction, secure env files, and runtime bootstrap.
- `errors.ts`: Defines `SandboxError`, which can render user-facing CLI diagnostics.
- `firecracker.ts`: Implements the Firecracker VM executor by running commands over SSH inside the VM.
- `gondolin-inventory.ts`: Persists per-runtime records (written by workers) under the state dir, reconciles them at startup, finds adoptable surviving runtimes, and maintains the mikan heartbeat workers watch.
- `gondolin-fleet.ts`: Multi-worker scheduler for `gondolin:remote` — sticky placement by capacity, draining, bounded queue-wait, lease-watermark-fenced failover, and stray-runtime reconciliation across mikan-worker daemons.
- `gondolin-gateway.ts`: Host side of dial-home workers — one mTLS listener accepting worker control channels (register/heartbeat/RPC), per-command dial-back tunnels, and unauthenticated join frames; keeps the connected-worker registry and attaches each worker to the fleet.
- `gondolin-join.ts`: Certificate authority and one-time-token authority for dial-home enrollment — auto-provisions the worker CA + gateway server cert, mints single-use hashed tokens, and signs worker CSRs.
- `gondolin-placement.ts`: Durable conversation→worker placement table with the lease-expiry watermark failover fencing respects.
- `gondolin-remote.ts`: Per-worker connection — fenced leases with heartbeat renewal, mTLS requests, and per-command upgraded tunnels to a `worker/` mikan-worker daemon.
- `gondolin-worker-client.ts`: mikan's side of the worker boundary — the local transport (spawn/adopt/stop detached workers) plus the exec-over-session state machine and transport interface shared with the remote path.
- `gondolin-worker-main.ts`: Entry point of the detached worker process (thin wrapper over `gondolin-worker.ts`).
- `gondolin-worker.ts`: Worker-side runtime: boots one Gondolin VM, records it in the inventory, announces readiness, and shuts down when the VM runner dies, on SIGTERM, or when the mikan heartbeat goes stale.
- `gondolin.ts`: Implements the Gondolin microVM executor: per-conversation worker-hosted runtimes, desired-runtime fingerprinting and drift recreation, resource limits, idle/sweep lifecycle, and crash recovery.
- `host.ts`: Implements the host executor by running commands directly through the local shell.
- `identity.ts`: Runtime actor identity — `actorKey()` and the single sanitizer naming a conversation's vault dir, docker container/network, and cloudflare sandbox suffix. Consumers take keys; nothing re-derives them.
- `image.ts`: Parses and validates `image:<image>` sandbox configs, which must later resolve to a concrete container executor.
- `index.ts`: Registers sandbox adapters and exposes parse, validate, and executor factory helpers.
- `path-context.ts`: Builds mounted runtime path contexts and translates runtime paths back to host paths.
- `types.ts`: Defines all sandbox configs, executors, exec results, runtime path contexts, and adapter types.
- `utils.ts`: Provides simple child-process execution, process-tree killing, shell escaping, and the shared base64-chunked file transport (`execReadFile`/`execWriteFile`) used by every exec-only executor.

## Host / sandbox path boundary (image mode)

mikan's primary deployment is `image:*`: the mikan process (LLM calls, session
persistence, extensions, platform bots) runs on the **host**, while agent tool
commands execute inside a per-conversation **container**. Everything on disk
belongs to exactly one of three trust classes:

### Host-only — under the state dir (`~/.mikan`), never mounted

| Path                                                   | Contents                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `settings.json`                                        | global settings                                                                            |
| `conversations/<id>/settings.json`                     | conversation settings (model, mount mode, …)                                               |
| `auth.json`, `models.json`                             | provider credentials and model catalog                                                     |
| `global/extensions/`, `conversations/<id>/extensions/` | extension **code** (runs in the host process)                                              |
| `global/`, `conversations/<id>/`                       | extension code (`extensions/`) + data (`extension-data/`) per scope; see harness LAYOUT.md |
| `vaults/…`                                             | credentials; `vaults/extensions/<slug>/env` = extension secrets                            |

Rules enforced in code:

- Extension code loads only from the state dir (`defaultExtensionDirs`);
  loading from a mounted path would let sandboxed code run on the host.
- Conversation settings are read from the state dir only. They historically
  lived at `<conversationDir>/settings.json` — which is bind-mounted rw — so
  a sandboxed agent could flip its own `sandbox.image.workspaceMount` to
  "full" and remount the whole workspace. `conversationSettingsPath()`
  migrates legacy files once and never reads the mounted location again.
- Startup refuses (fatal under sandboxed modes) a `--state-dir` located
  inside the working directory (`assertStateDirOutsideWorkspace`).
- Multi-instance hosts should give each instance its own `--state-dir`;
  conversation settings, auth, and vaults are keyed per state dir.

### Mounted read-write into the container — agent-writable by design

| Mount (private mode)                                | Purpose                                    |
| --------------------------------------------------- | ------------------------------------------ |
| `MEMORY.md` → `/workspace/MEMORY.md`                | agent-maintained global memory             |
| `skills/` → `/workspace/skills`                     | agent-creatable skills                     |
| `events/` → `/workspace/events`                     | event files (agent self-scheduling)        |
| `<conversationId>/` → `/workspace/<conversationId>` | sessions, scratch, per-conversation skills |
| vault mounts                                        | per-user credential injection              |

Full mode (per-conversation, admin/`/sandbox full`) mounts the entire working
directory at `/workspace` instead.

Consequences to keep in mind:

- **Session files are agent-writable.** A corrupted session header makes
  `SessionStore.open` throw instead of silently starting a fresh session
  (which would erase history on the next append); `/new` recovers.
- **Extension schedules are agent-visible and agent-tamperable**: they are
  event files in the shared events dir. Ownership prefixes are cooperative,
  not a security boundary — never put secrets in schedule text.
- **The events dir is a workspace-level scheduling bus — by design.** It is
  global and agent-writable, so any conversation's agent (or extension, or
  admin) can schedule runs in _any_ conversation. This is deliberate: one
  mikan workspace is one trust domain for scheduling, and cross-conversation
  events are exactly how PM-style workflows post reminders into other
  channels (e.g. agent-pm). Do not "fix" this by scoping events per
  conversation.
- Auto-reply config files live in the conversation dir and are therefore
  agent-toggleable (feature is deprecated).

### Paths in prompts and tool output

The model only ever sees **runtime** paths (`/workspace/…`); the host only
ever touches **host** paths. `path-context.ts` translates between them
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
