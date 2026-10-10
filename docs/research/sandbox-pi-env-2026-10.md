# Sandbox tools through Pi's pi-env

Date: 2026-10-11. `@earendil-works/pi-env` 1.1.0, `@earendil-works/pi-durable` 1.1.0; engines as in `sandbox-oci-engines-2026-10.md` (Docker via Colima, Podman 6.1.3 machine, nerdctl 2.3.1), all on macOS with `ghcr.io/geminixiang/mikan-sandbox:latest`.

## Question

`ContainerExecutionEnv` implemented Pi's `ExecutionEnv` over one `docker exec` per operation, with POSIX scripts for file operations, a `setsid` process-group protocol, an exit-status marker for nerdctl, and credentials over stdin. Does a maintained dependency already do this?

## Survey

| Candidate                           | Scope                                                   | Engines                               | Fit                                           |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| `@earendil-works/pi-env` (Pi)       | `RemoteExecutionEnv` plus a Rust daemon on stdin/stdout | any transport that runs the daemon    | the same interface, by Pi                     |
| testcontainers, dockerode           | lifecycle and exec over the Docker Engine HTTP API      | Docker; Podman through its API socket | no nerdctl, which has a CLI and no Docker API |
| `@ai-hero/sandcastle`               | agent-run orchestration                                 | Docker, Podman                        | a different agent model; no nerdctl           |
| kind (Go)                           | engine detection                                        | Docker → nerdctl → Podman             | reference only                                |
| `right-tool`, `container-dashboard` | CLI detection in scripts or a Pi extension              | all three                             | not libraries                                 |

No library covers container lifecycle through the nerdctl CLI, so the provisioner stays mikan's. pi-env covers everything inside the container.

## Experiment

The packaged Linux daemon was copied into a container and started with `<engine> exec -i <container> <daemon>` as the `Connection` command. Pi's conformance suite and the sandbox acceptance eval ran against `RemoteExecutionEnv` on each engine.

| Case                                                         | `ContainerExecutionEnv` (main)       | pi-env (branch), every engine   |
| ------------------------------------------------------------ | ------------------------------------ | ------------------------------- |
| Pi conformance, non-watch                                    | 15/15                                | 15/15                           |
| Pi conformance, watch                                        | 0/9 (`not_supported`)                | 9/9                             |
| Median ms per read / write / exec on macOS                   | 43 Docker, ~180 Podman, ~130 nerdctl | 1 / 0 / 1                       |
| nerdctl exit status                                          | needs a stderr marker                | carried by the protocol         |
| Commands after mikan dies                                    | swept at the next start              | killed when the connection ends |
| Tool eval (bash, write, edit, attach, `jev_browser`, `stop`) | pass                                 | pass                            |

## Decision

`createContainerExecutionEnv` returns pi-env's `RemoteExecutionEnv` over one process-wide connection per container; mikan keeps only the connection command, the daemon copy (named by the binary's SHA-256 under `/tmp`), readying the container once per run, and marking operations as use for idle stopping. The scripts, the process-group files and startup sweep, the exit marker, and the stdin credential encoding are removed.

## Accepted differences

- String commands run in the guest's `bash` when present, as Pi's `NodeExecutionEnv` does, instead of `sh`.
- Output past the spill thresholds goes to a file under the guest's temp directory, not `<workspace>/.mikan/bash-output/`.
- Each office with a running container keeps one `<engine> exec -i` client process on the host.
- Commands left running by a version before this change are not swept at startup; they end when their container stops or is replaced.

## Stability

Measured on `main` after the change, on macOS with Docker (Colima), Podman 6.1.3 (machine), and nerdctl 2.3.1 (Colima containerd); the Linux side runs in CI on Docker, Podman, and nerdctl.

### Test order

The three real-container test files (67 tests) ran 20 times per engine with a random order and seed each time: Docker, Podman rootless, Podman rootful, and nerdctl all passed 20 of 20.

### Soak with faults

Five containers on `ghcr.io/geminixiang/mikan-sandbox:latest`, each with a worker running random operations back to back: text write and read-back, `exec` with a random exit status, 1.2 MB of output, abort after 300 ms, 300 KB binary round trip, and six parallel commands on one connection. About every 20 s one container got a fault: `restart`, `kill` and `rm` (replacement), `stop`, `SIGKILL` of the host `exec -i` client, or `SIGKILL` of the daemon in the container.

| Engine  | Minutes | Operations | Faults | Corrupt results | Failures not near a fault | Recovery p50 / max | Failed operations per fault (max) |
| ------- | ------- | ---------- | ------ | --------------- | ------------------------- | ------------------ | --------------------------------- |
| Docker  | 60      | 259,193    | 174    | 0               | 0                         | 249 / 540 ms       | 2                                 |
| Podman  | 15      | 42,114     | 44     | 0               | 0                         | 746 / 1,555 ms     | 2                                 |
| nerdctl | 15      | 46,936     | 46     | 0               | 0                         | 532 / 1,074 ms     | 2                                 |

Every failure was an operation in flight when its connection was lost (`pi-env connection lost`), which pi-env reports instead of retrying because a mutation's outcome is then unknown. Every container recovered. Median `exec` latency was the same in the first and second half of each run (1–4 ms). The host kept one `exec -i` client per container (two for the nerdctl shim, which goes through `limactl`), file descriptors stayed at 38, and each container ended with exactly one daemon.

Memory: in a separate run that created 18,000 environments and ran every operation kind through them, the heap after GC stayed at 5.8–6.8 MB; RSS rose to about 240 MB in the first 10,000 rounds and then stayed flat, which is allocator retention of frame buffers, not a leak.

### Process lifetime

| Event                                                           | Docker                                                                                                          | Podman                                                                                                                                                     | nerdctl                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| mikan killed with `SIGKILL`                                     | commands and client gone in 0.5 s                                                                               | 0.5 s                                                                                                                                                      | 0.5 s through Colima; on native Linux the stream stays open and the daemon's 30 s ping timeout ends them (28 s measured, CI test allows 45 s) |
| Container replaced through `ensureReady` (`kill`, then `rm -f`) | next operation succeeds (15 of 15)                                                                              | 15 of 15                                                                                                                                                   | 15 of 15                                                                                                                                      |
| Engine VM stopped, then started                                 | —                                                                                                               | operations fail at once with the engine's error; a running command settles as lost; the first operation after start succeeds 0.8 s later and files persist | same, settled by the 30 s ping timeout; first operation after start succeeds                                                                  |
| mikan frozen (`SIGSTOP`) for 20 s / 40 s                        | a running command completes / settles as `connection timed out`, and the next operation reconnects              |                                                                                                                                                            |                                                                                                                                               |
| Daemon killed with `SIGKILL` in the container                   | the running command keeps running until it exits or the container stops; a new daemon serves the next operation | same                                                                                                                                                       | same                                                                                                                                          |

`rm -f` without a prior `kill` leaves Podman's `exec` client alive for about 10 s, so an operation right after a replacement can reach the dead stream; the provisioner already kills before removing.

### Slack E2E

Image mode with `ghcr.io/geminixiang/mikan-sandbox:latest`: 26 of 26 on Docker and 26 of 26 on Podman. The E2E script gives the daemon its own `HOME`, so Podman needs its connection configuration from the operator's `XDG_CONFIG_HOME`, as a deployment's own `HOME` provides.
