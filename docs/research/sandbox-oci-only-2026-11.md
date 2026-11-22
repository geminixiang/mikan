# One sandbox: removing `host` and `container:` (2026-11)

The refactor scope ([refactor-scope-2026-11.md](refactor-scope-2026-11.md)) keeps only the `oci` sandbox, a container mikan manages for each office (ADR 0022). This page records what the other two modes were, who used them, and what their removal changes.

## What existed

| Spec               | Where the agent ran                 | Vault                          | Office visibility  |
| ------------------ | ----------------------------------- | ------------------------------ | ------------------ |
| `host`             | On the machine, as the mikan user   | Not injected; keyed per person | Not enforced       |
| `container:<name>` | In one container the operator made  | Env only; keyed per container  | Not enforced       |
| `oci`, `oci:<img>` | In a container per office, by mikan | Env and file mounts per office | Enforced by mounts |

`host` was the default when `--sandbox` was absent. An `oci` office already resolved to a concrete container internally, so the container execution environment stays; what goes is the `container:<name>` spelling and everything that branched on the mode.

## Who used them

- The deployment the maintainers can observe starts with `--sandbox=oci`; no run there used another mode.
- `mikan onboard` and `deploy/pm2/ecosystem.config.cjs` write `--sandbox=oci`.
- The README called both modes not recommended.
- Tests: 18 files named `host` or `container`; five ran a runner on the host sandbox. They now inject a local execution context (`src/test/local-execution.ts`), added in the commit before this one.
- The embedder example, removed earlier, used `host`.

An operator elsewhere who started `mikan` with no flag is the one affected group: mikan now needs a container engine. This is stated in the changelog.

## Readers of the mode

| Reader                                           | Change                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sandbox/registry.ts`                        | The adapter registry (three adapters, capability lookups) becomes one parser and one validator                                                |
| `src/sandbox/host.ts`, `src/sandbox/identity.ts` | Deleted. Credential and resource keys were the office key under `oci`; callers use `officeKey`                                                |
| `src/sandbox/container.ts`                       | Loses the spec parser and validator; keeps the execution environment                                                                          |
| `src/harness/execution-resolver.ts`, `runner.ts` | No base config; the runner's second, resolver-less execution path is gone                                                                     |
| `src/harness/prompt.ts`                          | One environment description                                                                                                                   |
| `src/vault/index.ts`                             | Injection no longer takes capabilities; ambient shared vaults depend on the trust model only                                                  |
| `src/adapters/commands/login.ts`, admin portal   | No per-mode vault keys or labels                                                                                                              |
| `src/harness/tools/sandbox.ts`, `/pi-desktop`    | No "only supports oci" refusals                                                                                                               |
| `src/file-guards.ts`                             | A state directory inside the workspace always stops the start; `host` only warned                                                             |
| `src/cli/boot.ts`                                | No flag means `oci`                                                                                                                           |
| `src/migrations/`                                | `0002-actor-vaults` renamed `host` and `container:` vaults to keys nothing reads now; it is removed, and `mikan migrate --sandbox` is ignored |
| `SandboxConfig`                                  | `{ image }`; a discriminator with one value carried no information                                                                            |

## Choices

| Choice                               | Chosen                              | Alternative                                 | Reason                                                                                                                     |
| ------------------------------------ | ----------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| No `--sandbox` flag                  | `oci`, the published image          | Refuse to start and ask for the flag        | `mikan onboard` already writes `oci`; a default that works with a container engine is the smaller surprise                 |
| `--sandbox=host`, `container:<name>` | Refuse at startup, naming `oci`     | Run `oci` with a warning                    | Silently moving an agent from the machine into a container changes what it can reach; the operator should make that change |
| Vaults of `host` and `container:`    | Leave on disk, unread               | Migrate them to office vaults               | A per-person or per-container vault has no single office to move to; `/login` recreates what is needed                     |
| `mikan migrate --sandbox`            | Optional and ignored                | Remove the flag                             | The command an older daemon printed includes it, and the upgrade is exactly when it is run                                 |
| Tests' execution                     | An injected local execution context | A test-only sandbox mode in production code | Production keeps one path; the seam is an option `createRunner` defaults                                                   |

## Acceptance eval

`.workspace/sandbox-modes-eval/run.sh` runs a checkout's built CLI with no platform tokens and an empty state directory and records the exit code and first line for each spelling. The platform-token check runs before the sandbox is validated, so accepted spellings all end at "No platform tokens found".

| Invocation                             | Baseline (1724ea13)                                         | Expected                        | After                                             |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| `mikan` (no flag)                      | Reaches the token check (host)                              | Reaches the token check (oci)   | Reaches the token check                           |
| `--sandbox=host`                       | Reaches the token check                                     | Refused, names `oci` (accepted) | "--sandbox=host is not supported … use 'oci'"     |
| `--sandbox=container:name`             | Reaches the token check                                     | Refused, names `oci` (accepted) | "--sandbox=container:name is not supported …"     |
| `--sandbox=oci`                        | Reaches the token check                                     | Same                            | Same                                              |
| `--sandbox=oci:alpine:3`               | Reaches the token check                                     | Same                            | Same                                              |
| `--sandbox=image:alpine:3`             | Deprecation warning, then the token check                   | Same                            | Same                                              |
| `--sandbox=docker:x`                   | Refused, suggests `container:` or `oci:`                    | Refused, names `oci`            | "--sandbox=docker:x is not supported … use 'oci'" |
| `--sandbox=bogus`                      | "Invalid sandbox type … Use 'host', 'container:…', 'oci' …" | Invalid, names `oci` only       | "Invalid sandbox 'bogus'. Use 'oci' or 'oci:…'"   |
| `mikan migrate --sandbox host`         | Accepted (fails later: empty state)                         | Same                            | Same                                              |
| `mikan migrate --sandbox container:n`  | Accepted (fails later: empty state)                         | Same                            | Same                                              |
| `mikan migrate --sandbox oci:alpine:3` | Accepted (fails later: empty state)                         | Same                            | Same                                              |

Every row exits 1, before and after: none of these invocations has platform tokens or state. That `mikan migrate` also runs without the flag is covered by `cli-commands.test.ts`.

The `oci` run path itself is covered by the unchanged `oci` cases of `execution-resolver.test.ts` and the real-container tests, and by a run on real Slack with a local daemon.

## What an `oci` office sees differently

The system prompt's environment section changes for every `oci` office. The prompt was built from the resolved sandbox, and an `oci` office resolved to a `container` config, so it received the shared-container text: "You are running inside a shared container … Install tools with the container's package manager … Your changes persist across sessions". The text written for `oci` was never reached. With one mode left, every office gets it: "You are running inside a managed per-conversation container … Only files under the workspace persist; installed packages and anything else in the container are discarded when the sandbox image is updated". This is the accurate description (ADR 0009, ADR 0023): mikan replaces a container when its image changes.

Nothing else changes for an `oci` office: the container name, mounts, vault injection, credential key, and path context are computed as before, which the unchanged `oci` cases of `execution-resolver.test.ts` and `vault.test.ts` check.

## Verification on Slack

A local daemon built from this change, started with `--sandbox=oci` on a new state directory, answered a direct message on a real Slack workspace: the model called `bash`, mikan created the office's container from the published image, the command ran in `/workspace` on Debian 13 in 0.4 s, and the output came back in the reply. The Slack E2E workflow covers the rest.
