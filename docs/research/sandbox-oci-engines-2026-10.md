# Sandbox on Docker, Podman, and nerdctl

Date: 2026-10-11. Engines: Docker 29 via Colima, Podman 6.1.3 machine (rootless and rootful, crun, cgroup v2), nerdctl 2.3.1 on containerd in a Colima containerd VM, all on macOS with `ghcr.io/geminixiang/mikan-sandbox:latest`.

## Question

ADR 0022 chooses a sandbox backend by its contract. Can mikan's managed sandbox run on any engine that accepts the docker command set, without code per engine, and what does it rely on that only Docker does?

## Method

Each engine stood behind a `docker` command (a shim), so mikan's code ran unchanged: every provisioner query probed one by one, the provisioner lifecycle (create, reuse, boost, stop, start, reconcile, remove), Pi's `registerEnvConformance`, the real-container tests, and the sandbox acceptance eval (tools through a runtime and Slack bot with a faux model).

## Findings on `main`

| Query or behavior                                                 | Docker                | Podman                                        | nerdctl                                          |
| ----------------------------------------------------------------- | --------------------- | --------------------------------------------- | ------------------------------------------------ |
| `inspect {{json .HostConfig.Binds}}`                              | `src:dst[:ro]`        | adds `:rprivate,rbind`, so every check drifts | field missing, template error                    |
| `inspect {{.HostConfig.NetworkMode}}`                             | network name          | `bridge`, so every check drifts               | network name                                     |
| `.NetworkSettings.Networks` keys                                  | network name          | network name                                  | `unknown-eth0`                                   |
| `inspect {{.Image}}`                                              | image ID              | image ID (no `sha256:`)                       | image name                                       |
| missing network error                                             | `network … not found` | `network not found`                           | `no network found matching`, not recognized      |
| `update --cpus`                                                   | applied               | applied                                       | ignored; `--cpu-quota` applies                   |
| `exec` exit status                                                | passed through        | passed through                                | any nonzero becomes 1, plus a `level=fatal` line |
| `run -d --rm`                                                     | accepted              | accepted                                      | refused (test helper only)                       |
| `{{json .Mounts}}`, label `index`, `ps`/`network ls` name filters | same on all three     |                                               |                                                  |

Outcome on `main`: Docker passed everything; Podman passed conformance and tools but replaced the container on every provision, so installed packages vanished on each run; nerdctl could not create a container (unrecognized network error), passed 12 of 15 non-watch conformance cases, and reported every failing command as exit code 1.

On macOS nerdctl runs inside the VM, so a `--env-file` in the host temp directory is invisible to it and credentials silently go missing.

## Decision

Keep one code path and use only what the three engines answer alike:

| Need                        | Before                      | After                                                                               |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Which CLI                   | `"docker"` literals         | first of nerdctl, podman, docker whose `info` succeeds; `CONTAINER_ENGINE` pins one |
| Container or network exists | parse "not found" messages  | `ps -a` / `network ls` with `name=^…$`                                              |
| Bind drift                  | `.HostConfig.Binds` strings | `.Mounts` source, destination, and `RW`                                             |
| Network and image drift     | `NetworkMode`, `.Image`     | `mikan.network` and `mikan.image-id` labels set at `run`                            |
| CPU limit                   | `--cpus`                    | `--cpu-period 100000 --cpu-quota <cpus × 100000>`                                   |
| Command exit status         | `exec` exit code            | wrapper prints `mikan-exit-<random>:<status>` last on stderr                        |
| Credentials                 | `--env-file` in host temp   | base64 lines on `exec -i` stdin, exported by the wrapper                            |
| Start time                  | RFC 3339 only               | also Podman's `YYYY-MM-DD HH:MM:SS.n +ZZZZ TZ`                                      |
| Image for the ID label      | implicit pull by `run`      | explicit `pull` when the image is not local                                         |

Rejected: a driver per engine (more code, the same commands), the Docker Engine HTTP API (no help for nerdctl), and requiring rootful engines (rootless Podman passes where the host delegates the CPU and memory controllers).

## Results on the branch

| Case                                                         | Docker        | Podman (rootless)                     | nerdctl                       |
| ------------------------------------------------------------ | ------------- | ------------------------------------- | ----------------------------- |
| Pi conformance, non-watch                                    | 15/15         | 15/15                                 | 15/15 (was 12/15)             |
| Real-container tests (51)                                    | pass          | pass (rootful too)                    | pass                          |
| Provisioner lifecycle, no needless replace                   | pass          | pass (was replace on every provision) | pass (was create failure)     |
| `boost` reaches `cpu.max`                                    | 200000 100000 | 200000 100000                         | 200000 100000 (was unchanged) |
| Tool eval (bash, write, edit, attach, `jev_browser`, `stop`) | pass          | pass                                  | pass, exit codes correct      |
| Median ms per operation on macOS                             | 43            | 169–188                               | 127–135                       |

Podman and nerdctl latency on macOS is the VM hop (ssh and `limactl shell`); Linux hosts run the CLI natively and were not measured.

Upgrade: a container created by `main` has no `mikan.network` label, so the branch replaces it once on its first provision and reuses it afterwards; workspace and vault mounts carry over, packages installed in the container do not.

## Not covered

- nerdctl on a Linux host and Podman with a remote socket were not run; CI covers Docker and rootless Podman on Ubuntu.
- Rootless engines on hosts that do not delegate cgroup controllers cannot apply CPU or memory limits; `update` fails with a logged warning and provisioning continues.
