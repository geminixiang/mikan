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
