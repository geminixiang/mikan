---
title: Gondolin sandbox
description: Run mikan tools in a local Gondolin/QEMU microVM.
---

`gondolin:remote` is the distributed sandbox preview: mikan schedules Gondolin/QEMU VMs across authenticated workers. `image:*` remains the recommended single-machine managed sandbox. `gondolin:default` is retained as a local development and diagnostics profile for the same runtime implementation.

- **Single-machine managed sandbox**: `image:*`. Its host workspace stays durable through the existing bind-mount model.
- **Distributed sandbox**: `gondolin:remote`. It owns worker authentication, placement, leases, fencing, reconnect, and epoch-fenced runtime recreation.
- **Local Gondolin profile**: `gondolin:default` is a development and diagnostics path for the shared runtime implementation, not the successor to `image:*`.
- **Distributed workspace durability**: still an explicit open decision. Shared POSIX/NFS is the current same-LAN transport; it must not be treated as the final cross-WAN persistence model. See [Workspace transport research](./gondolin-workspace-transport-research/).

`gondolin:remote` currently has one active mikan coordinator and many workers. A
crash-recoverable owner record under the mikan state directory prevents a second local
coordinator from mutating the same placement/identity authority. A live local owner is
rejected; a dead PID from the same verified OS boot is reclaimed atomically; an
unreadable owner, another boot, or another machine fails closed because PID liveness
cannot be proven across those boundaries.

Discord and Telegram are rejected together in this profile until an operator completes
the explicit platform-namespaced storage migration. After a successful complete
migration, every adapter can share one coordinator without overlapping conversation IDs,
including through the Admin web portal. Do not run two mikan processes with
different state roots against the same fleet or share its static host credential with
independent coordinators: lease epochs are authoritative per worker, while placement
state is not a cross-host consensus system. Control-plane HA requires leader election
plus a linearizable placement backend and is outside the current preview contract.
Workers themselves are distributed and independently restartable; the gateway and
mikan coordinator remain one logical authority.

## Promotion gate

`gondolin:remote` remains a distributed preview until all of these are evidenced in the
release environment:

- the unit/contract suites and `go test ./...` pass;
- `scripts/smoke-test-remote-worker.sh` passes on a hardware-virtualized host, including
  two-worker fenced failover, worker certificate rotation and superseded-certificate
  replay rejection, worker restart, gateway restart, epoch-fenced runtime recreation
  with stale delayed-write rejection, and proof that the old detached runtime exits
  before replacement placement;
- every worker has completed the protocol-v2 rollout, returns an admissible clock sample,
  and the Admin diagnostics show clock uncertainty/skew within the five-second safety
  threshold; protocol-v1 compatibility is only a rolling-upgrade bridge;
- the release profile declares and tests its HTTP(S) egress policy; when internal-range
  blocking is enabled, metadata/link-local denial and every internal-host exception are
  evidenced in the deployment environment;
- static listen-mode deployments use a dedicated host-client CA and enforce the
  expected mikan host identity with `--client-cn`; the dial-home enrollment CA is not
  reused as a general worker API trust root;
- the same failover scenario passes with workers on **two separate machines** using the
  deployment's real shared-storage and network path; use
  `scripts/preflight-gondolin-fleet.sh <worker-a> <worker-b>` first to capture distinct
  machine identity, virtualization/runtime prerequisites, gateway reachability,
  shared-workspace visibility, and mutable latency, but do not count preflight alone as
  the fault-test evidence;
- a soak run covers control-channel reconnect, lease renewals, workspace health
  degradation/recovery, and repeated runtime create/stop cycles;
- the conversation storage/runtime identity has been migrated to a durable platform and
  workspace namespace before multi-platform operation is enabled; run
  `mikan --migrate-conversation-storage <manifest> --sandbox=gondolin:remote` with an
  explicit `{ "version": 1, "complete": true, "owners": { "<legacy-id>":
"slack|discord|telegram|github" } }` ownership inventory. The migration durably claims each whole
  directory, requires every enrolled worker to be connected, fences every legacy
  runtime/placement, migrates its conversation vault, and only then writes a
  workspace-bound completion record. Missing owners, disconnected workers, conflicts,
  or corrupt authority fail closed. Scoped normal operation and the Admin portal support
  Slack, Discord, Telegram, and GitHub without silently falling back to raw paths;
- the chosen cross-WAN workspace durability model has an implementation and recovery
  test. Shared POSIX/NFS is only an accepted same-LAN/VPC transport, not that final
  model.

GitHub-hosted CI runs the deterministic TS and Go suites. The VM and multi-machine
gates require hardware virtualization and deployment infrastructure, so they must run
on an explicitly provisioned self-hosted runner/environment; a green unit CI alone is
not a promotion signal. The [promotion evidence ledger](./gondolin-promotion-evidence/)
maps each requirement to its current artifact and records the remaining operator
inputs and product decisions.

## Requirements

- Node.js 23.6 or newer (Node.js 24 is recommended)
- QEMU installed and available to Gondolin
- hardware virtualization (KVM on Linux or HVF on macOS)

Build mikan's curated guest image once, then start mikan:

```bash
npm run gondolin:image:build
mikan --sandbox=gondolin:default /path/to/workspace
```

The image provides the core development environment from `docker/mikan-sandbox.Dockerfile`: Bash, build tools, Node.js/npm, Python/pip, uv, Git, ripgrep, fd, jq, SSH client, and common shell utilities. Its build configuration lives at `docker/gondolin-mikan-sandbox.json`; Gondolin verifies the generated asset manifest when importing it as `mikan-sandbox:latest`.

Each conversation gets a VM hosted by a dedicated, detached worker process; mikan talks to it over Gondolin's session IPC socket, one connection per command, so aborting or timing out a command kills it inside the guest. The default `private` workspace mode mounts only `MEMORY.md`, `skills`, `events`, and the current conversation under `/workspace`; `full` mounts the complete host workspace. Conversation vault environment variables are sent per command over the (user-only) socket. Commands and file tools run inside that VM with `TZ=Asia/Taipei`.

Directory mounts go through Gondolin's VFS. Single-file mounts cannot (the guest prepares every VFS mount point as a directory), so the worker projects them instead: file contents are copied into the guest at boot; files under `/workspace` (such as `MEMORY.md`) sync guest edits back to the host every couple of seconds and once more at shutdown, while vault credential files are projected owner-only (`600`) without write-back. Credential content is part of the runtime fingerprint, so rotating a credential on the host (e.g. re-running a login) recreates the runtime with a fresh projection on the conversation's next command. One consequence to know about: concurrent edits to the same projected file from two conversations are last-writer-wins rather than shared like a bind mount.

Remote `gondolin:remote` uses stricter restart semantics than the local profile below:
a new lease epoch fences and recreates a surviving VM rather than adopting it, because
a disconnected session cannot prove an already-admitted guest command has stopped.

Because local workers are detached, runtimes survive local mikan restarts and deploys: on the next command for a conversation, mikan adopts the surviving worker (after checking its fingerprint and health) instead of paying a VM boot. Workers watch their own VM — if the QEMU/krun runner dies, the worker exits, and mikan recreates the runtime on the next command; a worker killed outright is detected the same way and its orphaned runner is stopped before respawning. Workers also watch a mikan heartbeat file and shut themselves down once no mikan has been around for 45 minutes.

## Preview limitations

CPU/memory defaults, temporary limits from the agent `sandbox` tool, and `/pi-sandbox boost` use the same settings and conversation scope as `image:*`. Before each operation, mikan fingerprints the resolved image build, mounts, and effective limits. When that desired configuration changes, mikan waits for active work, closes the stale VM, and creates one replacement. Temporary limits reset after its session closes. Gondolin exposes whole vCPUs, so fractional CPU values are rounded up; strict fractional quotas require host cgroup enforcement.

Every local worker persists a runtime record under the state dir (`gondolin-runtimes/`), and mikan reconciles that inventory at startup: records whose worker is still alive are left for local-profile adoption, VM runners orphaned by a dead worker are verified and stopped, stale records are dropped, and Gondolin's own session registry is collected. Reconciliation is idempotent. Idle runtimes stop after 10 minutes (surviving workers that no conversation adopts are swept on the same schedule) and are recreated on the next operation.

`gondolin:remote` runs the same runtimes on one or more remote Linux/KVM machines through the [mikan-worker daemon](./gondolin-remote-worker/): mutual TLS, fenced leases, one tunnel per command, and sticky per-conversation placement across the fleet (capacity-aware, drainable, with lease-fenced failover), with the workspace on shared POSIX storage. The mikan host itself stays on the supported Node floor in this profile — Gondolin only runs on the workers. A worker or gateway reconnect acquires a higher lease epoch and stops the old VM before recreation; remote mode deliberately does not adopt a runtime across epochs because transport disconnect cannot prove an admitted guest command stopped. The [remote worker quickstart](./gondolin-remote-quickstart/) exercises this fencing behavior end to end. `image:*` remains the recommended single-machine mode while distributed Gondolin stays in preview.

An explicit HTTP(S) egress policy can opt into Gondolin's DNS-rebinding-safe host and
IP checks without changing existing deployments:

```jsonc
{
  "sandbox": {
    "gondolin": {
      "network": {
        "blockInternalRanges": true,
        "allowedHosts": ["api.github.com", "*.githubusercontent.com"],
        "allowedInternalHosts": [],
      },
    },
  },
}
```

`blockInternalRanges` defaults to `false`, so adding only a host allowlist does not
silently change existing VPC reachability. `allowedHosts` omitted means all HTTP hosts; an explicit empty list denies all.
`allowedInternalHosts` is the reviewed exception list for names that may resolve to
private, loopback, link-local, or metadata ranges and is rejected unless
`blockInternalRanges` is explicitly `true`. The policy is part of the runtime
fingerprint, travels identically through local and remote workers, and changing it
recreates the VM. Raw TCP remains restricted to explicit Gondolin TCP mappings and SSH
to explicit SSH policy/credentials.

Gondolin's network model is controlled HTTP/TLS rather than Docker-style generic NAT.
The [Kubernetes SIG Agent Sandbox research](./agent-sandbox-research/) compares its
controller/router/PVC model with Gondolin and records the secure-egress, ownership,
and lifecycle patterns worth adopting without treating PVCs as a WAN workspace
protocol. See [MicroVM migration research](./gondolin-migration-research/) for the compatibility and migration plan.
