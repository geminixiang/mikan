# Sandbox tools on Pi's ExecutionEnv

Date: 2026-10-10. Installed versions: `@earendil-works/pi-durable` 1.1.0, `mikan-sandbox:latest`.

## Question

Tools reached a container through two stacked interfaces: Pi's `ExecutionEnv`, which Pi's `read`, `write`, `edit`, and `bash` tools are written against, implemented by `ShellExecutionEnv` (`src/harness/execution-env.ts`) on top of mikan's own `Executor` (`exec`, `readFile`, `readFileBase64`, `writeFile`, path and config getters), implemented by `ContainerExecutor` over `docker exec`. `jev_browser`, `attach`, and prompt attachments used `Executor` directly. Can the sandbox hand tools Pi's interface directly, and what does the current adapter get wrong?

## Findings

1. **Pi publishes the contract and its test.** `ExecutionEnv` (`pi-durable/env`) is `FileSystem & Shell`. The Harness README says a custom environment sets `id` so equal ids see the same files, for example one per container, and checks itself with `registerEnvConformance()` from `pi-durable/testing`. Pi's tools call `exec`, `openBinaryReader`, `readTextFile`, `writeFile`, `fileInfo`, `exists`, `absolutePath`, `joinPath`, and `canonicalPath`; nothing in Pi or mikan calls `watch`.
2. **The old adapter failed most of the contract.** Pi's conformance suite against `ShellExecutionEnv` over `ContainerExecutor`:

   | Container image        | Passed | Failures                                                                                                                                             |
   | ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `mikan-sandbox:latest` | 6/24   | 9 watch cases (declared `not_supported`), byte-range and closed-reader errors, line scans, directory paging, stream order, argv `cwd`, `spawn_error` |
   | `debian:trixie-slim`   | 0/24   | as above, plus relative paths resolved against `/workspace` instead of the environment's `cwd`                                                       |

   Read from the code and confirmed by the eval below: `ShellExecOptions.env` was dropped, `onOutput` arrived only after the command ended, `cleanup()` did nothing, and `id` was random per instance, so Pi's per-file edit queue did not serialize two runs in one container.

3. **The sandbox needs no interface of its own.** Every in-sandbox API surveyed (E2B `commands`/`files`, Daytona `process`/`fs`, Modal `exec`/`filesystem`, Cloudflare Sandbox, OpenSandbox `execd`) is commands plus files plus optional watch, which `ExecutionEnv` covers. Lifecycle (create, suspend, persistence) differs between providers and stays mikan's, in `src/sandbox/`.
4. **Watching is not worth implementing.** No caller exists, and a container watcher would poll with a `docker exec` per interval. The conformance runner registers watch cases as skipped.
5. **Found, not changed:** in `image` mode the per-run system prompt describes "a shared container" whose "changes persist across sessions", because the prompt reads the resolved configuration (`container:<name>`). The change keeps that behavior; it needs its own fix.

## Decision

`ContainerExecutionEnv` in `src/sandbox/container.ts` implements `ExecutionEnv` directly over `docker exec`; `host` uses Pi's `NodeExecutionEnv`; `Executor`, `HostExecutor`, `ContainerExecutor`, `ShellExecutionEnv`, and the base64 file transport are removed. Each file operation is one POSIX script with exit statuses 70–74 for Pi's error codes and contents over stdin/stdout. Commands keep the `setsid` process-group protocol, so `sweepOrphanedCommands` still ends commands an earlier version left running.

| Choice                                        | Alternative                              | Reason                                                                                         |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Implement `ExecutionEnv` in `src/sandbox/`    | Keep `Executor`, fix `ShellExecutionEnv` | One interface, owned by Pi, with Pi's test; a second backend implements the same thing         |
| One script per file operation                 | Keep base64 chunks through argv          | Stdin removes chunking and ARG_MAX limits; writes take one `docker exec` instead of three      |
| Snapshot binary reader                        | Positional reads per call                | Same round trips as before; keeps the opened bytes after a rename as the contract requires     |
| `watch` returns `not_supported`               | Polling watcher                          | No caller; polling costs a `docker exec` per interval                                          |
| Host shim and real-container conformance runs | Real containers only                     | CI has Docker but no images; the shim covers the protocol on Linux, containers cover userlands |

## Eval

`.workspace/sandbox-env-eval/` drives a real runtime and Slack bot with a faux model against a `container:` sandbox, and the environment directly. Baseline is `main` at `80c75473`.

| Case                                      | main                   | branch            |
| ----------------------------------------- | ---------------------- | ----------------- |
| bash exit 3 with stdout and stderr        | error, both, code 3    | same              |
| bash timeout                              | timed out              | same              |
| write then read UTF-8                     | ok                     | same              |
| edit                                      | applied                | same              |
| read PNG                                  | Pi: images unsupported | same              |
| attach 4 KiB binary                       | identical bytes        | same              |
| `jev_browser` close                       | closed                 | same              |
| `stop` during `sleep`                     | 0 left in container    | same              |
| Pi conformance, non-watch                 | 6/15                   | 15/15             |
| Pi conformance, watch                     | 0/9                    | 0/9 (accepted)    |
| first output before command ends          | no                     | yes               |
| `exec` honors `options.env`               | no                     | yes               |
| one `id` per container                    | no                     | yes               |
| `cleanup()` ends running commands         | 3 processes left       | 0                 |
| median ms: read / write / exec / reader   | 45 / 137 / 47 / 45     | 43 / 41 / 42 / 40 |
| upgrade: orphan from main swept by branch | 3 → 0                  | 3 → 0             |
