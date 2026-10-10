---
status: accepted
---

# A sandbox backend is chosen by its contract, not its technology

mikan serves a team that trusts each other, so a sandbox is not a hostile multi-tenant boundary (ADR 0009) and needs no defense like gVisor or Kata. Isolation still has two jobs: the agent is untrusted, because it follows instructions from issues, pages, and files nobody vetted (ADR 0016), and one office's private data and one person's credentials must not reach another office (ADR 0008). Any technology can back the managed sandbox if it gives each Conversation office:

- **Environment isolation:** its own filesystem view, processes, and network; no added privileges (today: all capabilities dropped, `no-new-privileges`, a per-office bridge network); credentials only from that office's vault, injected per command and mounted read-only.
- **Resource isolation:** CPU, memory, and process-count limits the operator can read and change while it runs, and stopping an idle runtime.
- **Persistence:** the office workspace and vault survive restarts and runtime replacement (ADR 0014).
- **A workspace shared with the host:** the runtime runs on the same machine as mikan and mounts host directories, because mikan reads and writes the same files (memory, logs, skills, attachments). This is the single-node contract of ADR 0004; a remote runtime cannot be an office without first redesigning how the workspace reaches it (ADR 0002).

Tools reach the sandbox only through Pi's `ExecutionEnv`, so a backend is accepted when it passes Pi's `registerEnvConformance` suite and the sandbox acceptance eval on Linux and on macOS.

Today's backend is the `docker` command. mikan uses dockerd's layer, not only containerd's: per-office networks, label filters, live `update` of limits, and `--env-file`, through about a dozen commands (`run`, `exec`, `inspect`, `ps`, `start`, `stop`, `rm`, `update`, `network`, `image inspect`). Podman and nerdctl accept the same commands. It runs the same on Linux and on macOS, where every engine (Docker Desktop, Colima, OrbStack, Podman machine) runs Linux in a VM, and the deployment chooses the engine through `DOCKER_HOST`, `DOCKER_CONTEXT`, and `DOCKER_CONFIG` without a mikan setting.

## Considered Options

- **Contract first, docker CLI as the current backend (chosen):** a replacement is judged by the four properties and the tests, not by whether it is Docker.
- **Fix the technology (Docker only):** simpler to state, but rules out equal or better local options such as Podman, containerd with nerdctl, or Incus for no reason the team needs.
- **Strong-isolation runtimes by default (gVisor, Kata, mikan-owned VMs):** defend against hostile tenants the team does not have; Gondolin and Firecracker were removed in `ac5c61b8`.
- **Remote or elastic runtimes as offices (Kubernetes, E2B, cloud sandboxes):** fail the shared-workspace property; they belong to the Factory floor (ADR 0004).

## Consequences

- A new backend must reach all four properties on both operating systems before it ships, and the sandbox README names how it does each.
- With the docker CLI, every sandbox command inherits mikan's environment. A launcher that replaces `HOME` must also pass `DOCKER_CONFIG` or `DOCKER_HOST`, or the CLI falls back to the default socket; the local Slack E2E script did this, and every tool call failed until `DOCKER_CONFIG` was set.
- On macOS a bind mount reaches the container only from a path the engine's VM shares. The default state directory and workspace under the home directory work; under Colima a directory in the system temp directory (`/var/folders`) is mounted empty. Limits there divide the VM's resources, not the machine's.
- The guest is Linux, so guest scripts may assume a GNU or BusyBox userland; the host may be Linux or macOS.
- Not covered by this contract: disk and network bandwidth are not limited, and packages installed outside the workspace do not survive an image change (ADR 0014).
