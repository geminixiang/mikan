# src/sandbox

This directory defines sandbox abstractions, concrete sandbox executors, and shared sandbox utilities.

## Files

- `cloudflare.ts`: Implements the Cloudflare Sandbox bridge executor, argument parsing, health checks, and remote `/exec` calls.
- `container.ts`: Implements the Docker container executor, `docker exec` command construction, secure env files, and runtime bootstrap.
- `errors.ts`: Defines `SandboxError`, which can render user-facing CLI diagnostics.
- `firecracker.ts`: Implements the Firecracker VM executor by running commands over SSH inside the VM.
- `host.ts`: Implements the host executor by running commands directly through the local shell.
- `image.ts`: Parses and validates `image:<image>` sandbox configs, which must later resolve to a concrete container executor.
- `index.ts`: Registers sandbox adapters and exposes parse, validate, and executor factory helpers.
- `path-context.ts`: Builds mounted runtime path contexts and translates runtime paths back to host paths.
- `types.ts`: Defines all sandbox configs, executors, exec results, runtime path contexts, and adapter types.
- `utils.ts`: Provides simple child-process execution, process-tree killing, and shell escaping.

## Host / sandbox path boundary (image mode)

mikan's primary deployment is `image:*`: the mikan process (LLM calls, session
persistence, extensions, platform bots) runs on the **host**, while agent tool
commands execute inside a per-conversation **container**. Everything on disk
belongs to exactly one of three trust classes:

### Host-only — under the state dir (`~/.mikan`), never mounted

| Path                               | Contents                                                        |
| ---------------------------------- | --------------------------------------------------------------- |
| `settings.json`                    | global settings                                                 |
| `conversations/<id>/settings.json` | conversation settings (model, mount mode, …)                    |
| `auth.json`, `models.json`         | provider credentials and model catalog                          |
| `extensions/…`                     | extension **code** (runs in the host process)                   |
| `extension-data/<slug>/`           | per-extension data dirs                                         |
| `vaults/…`                         | credentials; `vaults/extensions/<slug>/env` = extension secrets |

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
- **Known gap:** the events dir is global and agent-writable, so a container
  can write an event targeting _another_ conversation (cross-conversation
  instruction injection). Fix under consideration: per-conversation events
  subdirectories with provenance-based trust.
- Auto-reply config files live in the conversation dir and are therefore
  agent-toggleable (feature is deprecated).

### Paths in prompts and tool output

The model only ever sees **runtime** paths (`/workspace/…`); the host only
ever touches **host** paths. `path-context.ts` translates between them
(skill locations, upload paths). Extension-shipped skills are the exception:
their files live under the host-only state dir, so their bodies are inlined
into the system prompt instead of referenced by path.
