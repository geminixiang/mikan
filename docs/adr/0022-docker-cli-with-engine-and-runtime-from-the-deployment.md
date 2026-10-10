---
status: accepted
---

# mikan speaks the docker CLI; the deployment picks the engine and runtime

The managed sandbox must run on Linux servers and on macOS, where every container engine (Docker Desktop, Colima, OrbStack, Podman machine) runs Linux in a VM. mikan drives containers only through the `docker` command, and that command's own configuration chooses everything below it: `DOCKER_HOST`, `DOCKER_CONTEXT`, and `DOCKER_CONFIG` select the engine, and the engine's configuration selects the OCI runtime (runc, gVisor `runsc`, Kata). mikan adds no engine or runtime setting. Tools never see this layer: they use Pi's `ExecutionEnv`, which `src/sandbox/` implements over `docker exec`.

## Considered Options

- **The docker CLI, configured by the deployment (chosen):** about a dozen commands (`run`, `exec`, `inspect`, `ps`, `start`, `stop`, `rm`, `update`, `network`, `image inspect`), the de facto standard that Podman and nerdctl also accept. One code path on both operating systems, and switching engines or runtimes changes no mikan code.
- **An engine setting (`docker`, `podman`, `nerdctl`):** a new knob and a code path per engine, for engines that already accept the docker CLI.
- **The Docker Engine HTTP API:** saves starting a CLI process per operation, which today takes about 40 ms in all, but needs mikan's own client and exec stream demultiplexing; no measured need.
- **CRI (containerd, CRI-O):** the Kubernetes sandbox interface; worth it only for a Kubernetes deployment.
- **mikan-owned VMs:** Gondolin and Firecracker were removed in `ac5c61b8`; Kata gives VM isolation through the engine instead.

## Consequences

- Every sandbox command inherits mikan's environment. A launcher that replaces `HOME` must also pass `DOCKER_CONFIG` or `DOCKER_HOST`, or the CLI falls back to the default socket; the local Slack E2E script did this, and every tool call failed until `DOCKER_CONFIG` was set.
- On macOS a bind mount reaches the container only from a path the engine's VM shares. The default state directory and workspace under the home directory work; under Colima a directory in the system temp directory (`/var/folders`) is mounted empty, so writes in the container never reach the host.
- The guest is always Linux, so guest scripts may assume a GNU or BusyBox userland; the host may be Linux or macOS.
- Another engine or runtime is supported once it passes Pi's `registerEnvConformance` suite and the sandbox acceptance eval; CI covers only Docker's protocol through a Linux host shim.
