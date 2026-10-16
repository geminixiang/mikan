# Credentials and sandboxes scoped to a person (2026-10)

Question: today a Conversation office bundles the conversation, its workspace, one Sandbox runtime, and one Vault. In a shared channel everyone who calls the agent drives the same computer with the same credentials. Can a run use the computer and credentials of the person who called it, while the conversation and its working files stay shared?

Sources: git history of `src/vault/`, `src/sandbox/identity.ts`, `src/harness/execution-resolver.ts`, `src/office/projection.ts`, `src/harness/runner.ts`, ADRs 0003, 0005, 0008, 0013, 0016, 0027, and pi-durable 1.3.0 `HarnessOptions.env`. Experiments are under `.workspace/person-laptop/` (results in `RESULTS.md`): a real Slack workspace with two human accounts driving a local daemon, and a Linux VM matching the production OS and kernel.

## History

| When       | Commit                 | State                                                                                                                                                       |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04    | `f6081e75`, `dd9566a7` | Vault and managed container keyed by the platform user. A `bindings.json` store mapped users on several platforms to one identity, with a `revoked` status. |
| 2026-05-05 | `728aa86d`             | Managed sandboxes and their vaults re-keyed by conversation. The commit records no reason.                                                                  |
| 2026-05-08 | `9b20b887`             | Shared vault profiles (`/login copy`) added, so each new conversation could get credentials without a new login.                                            |
| 2026-05-14 | `156cfbbc`             | `bindings.json` removed as unused.                                                                                                                          |
| 2026-07    | ADRs 0003–0005         | Conversation office formalised; vault keyed by office key. Host mode keeps a user key.                                                                      |
| 2026-09-24 | `cec86ddb`             | `sandbox.defaultSharedVault` retired.                                                                                                                       |

Production, read-only inventory: 366 vault directories; 365 are byte-identical copies of one shared profile (Google Workspace OAuth, gcloud credentials, Sentry, env), all created before the retirement. Since then agents in sandboxes ran `gcloud` about 3,500 times and `gws` about 500 times in four weeks, so the copied credentials are in active use. Offices active in that period: 73, with 53 distinct people; 40 offices have one person.

## Model under study

Split the office by owner:

| Part                                          | Belongs to                      | Why                      |
| --------------------------------------------- | ------------------------------- | ------------------------ |
| Conversation, memory, office directory        | The place (DM, channel, thread) | Shared by everyone in it |
| Sandbox (the computer) and its home directory | The person who called           | Follows the credentials  |
| Vault                                         | The person                      | Credentials are personal |

A run's working directory is the office directory of its conversation, mounted into the caller's computer, so a thread continues on whichever computer the next caller has. In a DM the office directory is only ever mounted for its one person.

## What the session layer already supports

| Need                                      | State                                                | Where                                |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Pick the computer per run from the caller | Each run resolves its env from `ActorContext.userId` | `execution-resolver.ts`, `runner.ts` |
| Pi asks for the env at each use           | Not cached                                           | pi-durable `HarnessOptions.env`      |
| Only the run's caller can steer it        | Enforced                                             | `runner.ts` steer check              |
| Child conversations use the owner's env   | Owner chain                                          | `session-store.ts`                   |

Gaps: the run cause entry records only the message id, so a run continued after restart (ADR 0027) does not know its caller; the runner keeps one resolved env, so a background task can move to another caller's computer when someone else uses the same session; runs without a caller (scheduled events, webhooks, unknown Telegram senders, external Slack Connect members) need a computer without personal credentials.

## Experiments

### Baseline and prototype on Slack

Prototype (branch `exp/person-laptop`): container and vault keyed by person, the container mounts every office the person has used, working directory set to the current office, home bind-mounted from the state dir.

| Case                                                                        | Baseline (office = conversation) | Prototype                                                                                |
| --------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Two people in one channel                                                   | Same container                   | Separate containers                                                                      |
| Second person reads the first person's vault token                          | Leaks it                         | Not present                                                                              |
| Second person reads the first person's `git config --global`                | Leaks it                         | Unset                                                                                    |
| Second person reads a file the first wrote in the working directory         | Readable                         | Readable                                                                                 |
| Second person continues the first person's thread repository                | Works                            | Works                                                                                    |
| A person's DM files from their channel runs                                 | Not visible                      | Visible                                                                                  |
| Both call at once                                                           | Both answer, one container       | Both answer, two containers                                                              |
| Home after container recreation                                             | —                                | Lost without a home mount; kept with it                                                  |
| A person enters a new conversation while another of their runs is in `bash` | —                                | Container recreated in about 2 s; the running command dies with `pi-env connection lost` |

Two side findings: in the baseline the working directory is `/workspace`, the container layer, so files written with relative paths never reached the office directory; and vault file mounts under `/root` would collide with a home mount, but with a personal home they can be written into it.

### Live mounts instead of recreation (Linux)

Each computer mounts one host directory at `/workspace` with `bind-propagation=rslave`; the host makes it `rshared` and bind-mounts office directories under it while the container runs. Debian 12, kernel 6.1, Docker 29.9.

| Check                                                                                     | Result                                                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Attach an office to a running container                                                   | Visible at once; 11 ms on the host                                    |
| Long-running process during attach and detach                                             | Unaffected                                                            |
| Container tries to unmount                                                                | Refused without privilege                                             |
| Container restart                                                                         | Same container, mounts kept                                           |
| Read-only with `mount --bind` then `remount,ro` (util-linux 2.38, the production version) | Writable inside the container: the copy propagates before the remount |
| Read-only with `open_tree`, `mount_setattr(MOUNT_ATTR_RDONLY)`, `move_mount`              | Read-only inside the container                                        |

### Live mount risk checks

| Check                                                         | Result                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation: a second computer sees the first one's live mounts | No: none in its `/proc/mounts`; directories a container creates stay local; a container cannot mount                                                                                                                              |
| Docker daemon restart                                         | Containers exit; `start` brings back every live mount, and later attaches still propagate                                                                                                                                         |
| Host reboot                                                   | Host mounts are gone; a plain `start` succeeds and shows empty mount-point directories without error. Re-creating the shared root and re-attaching before `start` restores everything. A reconciler before each run is mandatory. |
| 40 computers × 80 offices, 3,200 live mounts                  | Attach 5.5 ms on average, 9 ms at full scale; `exec` 75 ms; load 0.9; no cross-visibility; full teardown 83 s                                                                                                                     |
| Podman 4.3 and nerdctl 2.1                                    | Both propagate live mounts with `bind-propagation=rslave`                                                                                                                                                                         |

### Existing sandbox managers

E2B, microsandbox, Kubernetes `agent-sandbox`, Daytona, and OpenKruise agents all attach storage when a sandbox is created or claimed; none documents attaching to a running sandbox. Docker has no `update --mount`; its documentation describes the propagation technique used above and notes that Docker Desktop cannot use it.

## Not yet verified

- Which mode global `MEMORY.md` and skills get when one computer serves private and public offices.
- One person on several platforms, and migration of existing vaults, `/pi-login` credentials, and container state.

## Options so far

| Option                                                              | Isolation between callers | Runs survive a new conversation | Mechanism                                                                       |
| ------------------------------------------------------------------- | ------------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| Today                                                               | No                        | Yes                             | One container per office                                                        |
| A: one container per person and office, shared personal home        | Yes                       | Yes                             | Fixed mounts; about 3x the containers                                           |
| B: one container per person, recreated when a conversation is added | Yes                       | No                              | Fixed mounts                                                                    |
| B with live mounts (Linux) and recreation as the macOS fallback     | Yes                       | Yes on Linux                    | Host mount management by the daemon as root, plus a helper for read-only attach |
