---
status: accepted
---

# A sandbox backend is chosen by its contract, not its technology

mikan serves a team that trusts each other, so a sandbox is not a hostile multi-tenant boundary (ADR 0009). Any technology can back the managed sandbox if it gives each Conversation office three things: **environment isolation** (its own filesystem view, processes, and credentials, so the agent cannot reach the host's secrets or another private office; ADR 0016 still treats the agent as untrusted), **resource isolation** (CPU and memory limits the operator can read and change while it runs), and **persistence** (the office workspace and vault survive restarts and runtime replacement; ADR 0014). Tools reach it only through Pi's `ExecutionEnv`, so a backend is accepted when it passes Pi's `registerEnvConformance` suite and the sandbox acceptance eval, on both Linux and macOS.

Today's backend is the `docker` command. It meets the contract with about a dozen commands (`run`, `exec`, `inspect`, `ps`, `start`, `stop`, `rm`, `update`, `network`, `image inspect`), runs the same on Linux and on macOS, where every engine (Docker Desktop, Colima, OrbStack, Podman machine) runs Linux in a VM, and lets the deployment choose the engine through `DOCKER_HOST`, `DOCKER_CONTEXT`, and `DOCKER_CONFIG` without a mikan setting.

## Considered Options

- **Contract first, docker CLI as the current backend (chosen):** a replacement is judged by the three properties and the tests, not by whether it is Docker.
- **Fix the technology (Docker only):** simpler to state, but rules out equal or better options such as Podman, containerd, or Incus for no reason the team needs.
- **Strong-isolation runtimes by default (gVisor, Kata, mikan-owned VMs):** defend against hostile tenants the team does not have; Gondolin and Firecracker were removed in `ac5c61b8`.

## Consequences

- A new backend must reach the same three properties on both operating systems before it ships, and the sandbox README names how it does each.
- With the docker CLI, every sandbox command inherits mikan's environment. A launcher that replaces `HOME` must also pass `DOCKER_CONFIG` or `DOCKER_HOST`, or the CLI falls back to the default socket; the local Slack E2E script did this, and every tool call failed until `DOCKER_CONFIG` was set.
- On macOS a bind mount reaches the container only from a path the engine's VM shares. The default state directory and workspace under the home directory work; under Colima a directory in the system temp directory (`/var/folders`) is mounted empty.
- The guest is Linux, so guest scripts may assume a GNU or BusyBox userland; the host may be Linux or macOS.
