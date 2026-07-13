---
title: MicroVM sandbox migration research
description: Feasibility research for moving mikan's managed image sandbox to a local-to-fleet Gondolin/QEMU architecture.
---

Generated: 2026-07-13

## Feasibility verdict

**Conditional go.** mikan can support a single-machine to multi-machine microVM
sandbox architecture on reliable foundations, provided that the product is a
specialized agent sandbox rather than a drop-in replacement for arbitrary Docker
images.

The dependable lower layers already exist:

- QEMU provides the VM boundary and hardware acceleration through KVM on Linux
  and HVF on macOS. QEMU treats hardware-accelerated virtualization as its
  security-supported isolation use case; TCG is not a production security or
  performance fallback. ([QEMU accelerators](https://www.qemu.org/docs/master/system/introduction.html),
  [QEMU security model](https://www.qemu.org/docs/master/system/security.html))
- Gondolin already supplies the local agent-sandbox control plane mikan would
  otherwise have to build over QEMU: VM lifecycle, command execution, VFS,
  mediated networking, secret placeholders, and disk checkpoints.
  ([Gondolin architecture](https://earendil-works.github.io/gondolin/architecture/),
  [VM API](https://earendil-works.github.io/gondolin/sdk-vm/))
- Git, shared POSIX storage, and an external Vault implementation are mature
  building blocks for workspace and secret delivery when used with explicit
  ownership rules. They do not provide mikan's scheduling semantics by
  themselves.

The missing distributed layer is substantial but bounded. mikan must build a
worker daemon, worker authentication, durable leases, placement, reconciliation,
workspace preparation/finalization, scoped secret delivery, resource enforcement,
and operational telemetry. Gondolin is local-first and does not provide any of
those fleet functions.

This should therefore proceed only behind a mikan-owned worker/runtime interface.
Do not make Gondolin's API, local session registry, or QEMU process identity part
of mikan's persisted public contract.

## Current mikan contract

The behavior to preserve is not the `image:*` parser. The managed contract is
implemented across `src/execution-resolver.ts`, `src/provisioner.ts`,
`src/sandbox/container.ts`, `src/vault/index.ts`, and the sandbox command/tool.

`image:*` currently provides:

- one conversation vault key mapped to one managed runtime
- create, start, stop, recreate, reconcile, and idle-stop lifecycle management
- private and full workspace modes mounted at `/workspace`
- vault environment injection at command execution time
- writable vault file credential projection
- per-runtime network isolation
- CPU/memory defaults, temporary overrides, and boost controls
- drift detection and recreation when mounts or network configuration change

The migration can preserve the user-visible lifecycle and `/workspace` concepts.
It cannot preserve arbitrary OCI image compatibility, unrestricted Docker-style
networking, writable secret mounts, and dynamic resource changes without either
changing their semantics or building significant additional machinery.

## Foundation assessment

| Component                | Assessment                                            | Safe reliance                                                                                | mikan responsibility                                                                        |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| QEMU with KVM/HVF        | Mature foundation                                     | VM process, hardware boundary, virtio devices, Linux/macOS acceleration                      | Pin supported QEMU versions and reject TCG for untrusted production workloads               |
| Gondolin QEMU backend    | Promising integration foundation, still early         | Local VM create/exec/close, VFS, network mediation, secret placeholders, qcow2 checkpoints   | Version pinning, compatibility tests, lifecycle reconciliation, fleet control               |
| Gondolin VFS             | Useful but younger than QEMU                          | Explicit host paths, memory/real/read-only/shadow providers                                  | Workspace policy, concurrency, remote materialization, performance testing                  |
| Gondolin secrets         | Strong for HTTP header credentials                    | Real secret remains in trusted host process and is substituted only for allowed destinations | Deliver scoped values to the worker, define allowed hosts, handle non-HTTP/file credentials |
| Gondolin checkpoints     | Useful optimization, not durable runtime migration    | Disk-only qcow2 checkpoint and resume against matching guest assets                          | Store/transfer checkpoint plus asset build identity; recreate processes after failure       |
| Linux cgroup v2          | Mature Linux resource-control foundation              | CPU, memory, and I/O enforcement around the worker/QEMU process                              | Create per-sandbox cgroups and collect usage/termination reasons                            |
| Git/worktrees            | Mature source workspace foundation                    | Worker-local repository cache and isolated working trees                                     | Preserve uncommitted/non-Git data and publish results safely                                |
| NFS/shared POSIX storage | Mature deployment option with limited cache coherence | Avoid bulk workspace transfer and keep a stable logical path                                 | Enforce one writer, fencing, lock discipline, and recovery after worker loss                |
| Vault response wrapping  | Mature optional secret handoff primitive              | Short-lived, single-use delivery token instead of the secret in transit                      | Policy, worker identity, unwrap validation, renewal, revocation, audit                      |

Primary-source qualifications behind this table:

- Gondolin calls itself an early project. Its current published package is
  `0.12.0`, and the package requires Node `>=23.6.0`, while mikan currently
  supports Node `>=22.19.0`. A separate worker process running Node 24 avoids
  forcing an immediate mikan host runtime upgrade.
  ([Gondolin docs](https://earendil-works.github.io/gondolin/),
  [package.json](https://github.com/earendil-works/gondolin/blob/main/host/package.json),
  [releases](https://github.com/earendil-works/gondolin/releases))
- Gondolin says ARM64 is its most-tested runtime path. Its repository CI builds
  both guest architectures, but this is not evidence of a long production track
  record across every Linux/macOS and QEMU combination.
  ([Gondolin README](https://github.com/earendil-works/gondolin),
  [Gondolin CI](https://github.com/earendil-works/gondolin/blob/main/.github/workflows/ci.yml))
- Gondolin's VFS vendors and patches a snapshot of Node's VFS implementation.
  That is a useful implementation, but mikan must test real repository semantics
  such as symlinks, permissions, rename, watchers, package managers, and large
  trees before treating it as bind-mount equivalent.
  ([VFS implementation note](https://earendil-works.github.io/gondolin/vfs/))
- Gondolin explicitly states that it has no complete denial-of-service resource
  governance. Linux cgroup v2 supplies hard memory and CPU/I/O controls outside
  Gondolin; there is no equivalent cross-platform foundation established by the
  Gondolin documentation for macOS.
  ([Gondolin security design](https://earendil-works.github.io/gondolin/security/),
  [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html))
- NFSv4.1 does not provide general distributed cache coherence. Concurrent
  writers must coordinate with locks/share reservations, so a mikan lease cannot
  be treated as optional metadata when workers share a workspace.
  ([RFC 8881, section 10](https://www.rfc-editor.org/rfc/rfc8881.html#section-10))

## `image:*` parity

| Existing behavior                      | Gondolin/QEMU capability                                                              | Verdict                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Per-conversation managed runtime       | Stable VM session UUID and create/exec/close APIs                                     | Yes; mikan owns conversation mapping and reconciliation                 |
| Command execution and streaming        | Buffered/streamed output, PTY, cancellation, bounded backpressure                     | Yes                                                                     |
| Local private/full workspace           | `RealFSProvider`, `ReadonlyProvider`, `ShadowProvider`, mount routing                 | Yes, after semantic and performance tests                               |
| Remote workspace                       | No fleet workspace transport                                                          | No; mikan must provide it                                               |
| HTTP API secrets                       | Destination-scoped host substitution using guest placeholders                         | Yes, with safer semantics than guest env injection                      |
| File and non-HTTP credentials          | Explicit VFS projection or mapped TCP/SSH exceptions                                  | Partial; values enter the guest and need an opt-in compatibility policy |
| Static CPU/memory at VM creation       | `sandbox.cpus` and `sandbox.memory`                                                   | Yes                                                                     |
| Dynamic boost/temporary limits         | No documented Gondolin runtime resize contract; no complete DoS governance            | No direct parity; recreate or enforce externally                        |
| Idle stop                              | Fast disposable VM lifecycle                                                          | Yes; mikan owns timers and policy                                       |
| Docker bridge/general outbound network | Mediated HTTP/TLS, explicit SSH and mapped TCP, no generic NAT                        | Intentional incompatibility                                             |
| Arbitrary Docker/OCI image             | Alpine image builder; optional OCI rootfs source is not arbitrary container execution | No                                                                      |
| Live migration/failover                | Disk-only checkpoint; no RAM/process snapshot                                         | No; failover means re-provision and restart                             |
| Multi-machine scheduling               | Local sessions and Unix sockets only                                                  | No; mikan must provide it                                               |

Gondolin's documented limitations also include no HTTP/2, HTTP/3, QUIC, WebRTC,
or generic UDP in the default network model, and an Alpine-only image builder.
These are product constraints, not minor migration bugs.
([Gondolin limitations](https://earendil-works.github.io/gondolin/limitations/),
[custom images](https://earendil-works.github.io/gondolin/custom-images/))

## Recommended architecture

Single-machine and multi-machine deployments should use the same control path:

```text
mikan host
  -> SandboxScheduler
  -> WorkerClient
  -> local Unix socket or remote mTLS
  -> mikan-worker
  -> Gondolin
  -> QEMU/KVM or QEMU/HVF
```

The single-machine deployment runs `mikan host` and `mikan-worker` on the same
machine. The multi-machine deployment changes worker discovery and the workspace
provider, not the sandbox execution contract. Keeping the worker as a separate
process also isolates Gondolin's Node version and QEMU process management from
the chat/control process.

### Control-plane ownership

The mikan host remains authoritative for:

- conversation/session routing
- vault policy and secret authorization
- worker registry and health
- sandbox profiles and image build IDs
- lease allocation and fencing epochs
- run queue and idempotency records
- workspace generation and finalization state

The requested topology has one authoritative mikan host and multiple workers.
It does not require distributed consensus because the host is the sole scheduler.
Host high availability would be a separate project requiring a shared durable
store and leader election.

### Worker ownership

Each worker owns only local execution concerns:

- validate its identity and the signed/scoped lease
- prepare a worker-local workspace path
- start and supervise Gondolin/QEMU
- execute commands and stream output
- apply network and VFS policy
- hold lease-scoped secret values in memory
- enforce local resource limits
- report health, capacity, usage, and exit reasons
- finalize workspace results and remove ephemeral state

Gondolin's own session registry is local metadata under its cache directory and
supports local attach/list workflows. It is not the fleet source of truth.
([Gondolin VM sessions](https://earendil-works.github.io/gondolin/sdk-vm/))

### Minimal worker protocol

Keep the protocol specialized:

- `lease`: reserve a sandbox profile and workspace generation
- `exec`: execute under a lease with a request ID
- `status`: report sandbox and workspace state
- `stop`: stop the VM but retain explicitly durable workspace state
- `release`: finalize or discard workspace state and revoke secrets
- `health`: advertise capacity, OS, architecture, accelerator, profiles, and
  cached guest asset build IDs

Every mutating request needs an idempotency key. Every lease needs a monotonically
increasing fencing epoch. A worker must reject stale epochs so a partitioned old
worker cannot continue writing after the host has reassigned the conversation.
The practical execution guarantee is at-least-once: mikan cannot promise
exactly-once shell side effects across worker or network failure.

### Scheduling and lifecycle

Use sticky placement while a conversation is active:

1. Select a healthy worker matching OS/architecture/profile and free capacity.
2. Create a durable lease containing worker ID, sandbox ID, workspace generation,
   profile/image build ID, fencing epoch, and expiry.
3. Renew it through worker heartbeats while the VM is active.
4. Stop the VM after the idle timeout but retain only workspace state declared
   durable by the selected provider.
5. On worker loss, expire the lease, increment the fencing epoch, prepare the
   latest committed workspace generation elsewhere, and create a new VM.

Disk checkpoints are optional cold-start caches, not lease authority. Gondolin
checkpoints stop the source VM, exclude tmpfs and VFS-mounted workspace state,
and require matching guest assets by build ID to resume.
([Gondolin snapshots](https://earendil-works.github.io/gondolin/snapshots/),
[lifecycle guidance](https://earendil-works.github.io/gondolin/workloads/))

## Workspace architecture options

The worker must always receive a local directory to pass to Gondolin's
`RealFSProvider`. A `WorkspaceProvider` boundary should implement conceptually:
prepare a generation on a worker, expose its local path, then finalize or abort
that generation. This is the main switch between deployment sizes.

### Option A: local path

Use the existing host workspace directly when host and worker share a machine.
This gives the lowest startup cost and preserves current behavior. It is phase 1,
not a remote-worker solution.

### Option B: shared filesystem

Mount the same NFS or managed POSIX filesystem on every worker. This avoids
copying the workspace during startup and is the simplest first remote deployment.
The guest still sees only the directory and policy exposed through Gondolin VFS.

Required constraints:

- exactly one active writable lease per conversation workspace
- fencing before reassignment after a worker partition or crash
- no assumption of general cache coherence between workers
- explicit atomic markers/generations for completed turns
- benchmark package installs and large source trees because each guest VFS call
  reaches Gondolin on the worker and may then reach network storage

This is the recommended first multi-machine workspace model because it keeps
single-to-multi migration operationally small. It is not the final high-scale
model.

### Option C: worker-local Git cache and worktree

Maintain a bare/object cache per worker and create a worktree for each lease.
Git worktrees share repository objects while retaining separate `HEAD` and index
state; partial clone can reduce initial transfer and fetch missing objects on
demand. ([Git worktree](https://git-scm.com/docs/git-worktree.html),
[partial clone](https://git-scm.com/docs/partial-clone))

This gives fast local I/O and scales better than shared storage for source-heavy
workloads. It does not preserve arbitrary workspace semantics by itself:
untracked files, ignored build output, local-only repositories, conversation
artifacts, and uncommitted host changes need a separate snapshot/artifact channel.
Use this only after the product defines which workspace state is authoritative.

### Option D: content-addressed workspace generations

Create a manifest of paths, metadata, and content digests; upload missing blobs;
materialize a generation on the selected worker; atomically publish a new
generation after execution. This supports non-Git workspaces and incremental
transfer, but mikan must build integrity verification, garbage collection,
conflict policy, symlink/permission semantics, interrupted upload recovery, and
artifact size limits.

This is a later optimization, not a prerequisite for the first multi-worker
release.

### Rejected default: remote VFS back to the host

Gondolin permits custom JavaScript VFS providers, so a worker could proxy every
filesystem operation to the mikan host. Do not make this the default. Gondolin's
guest-to-provider path already uses FUSE/RPC and caps individual RPC payloads;
adding host-to-worker network latency to every filesystem operation creates a
fragile, chatty distributed filesystem.
([Gondolin VFS](https://earendil-works.github.io/gondolin/vfs/),
[security design](https://earendil-works.github.io/gondolin/security/))

## Vault and secret delivery

The remote worker is part of the trusted computing base. Gondolin's guarantee is
that a real HTTP secret stays in the trusted host process and never enters the
guest; in a fleet, that trusted host process runs on the worker.
([Gondolin secrets](https://earendil-works.github.io/gondolin/secrets/),
[security model](https://earendil-works.github.io/gondolin/security/))

Recommended flow:

1. The mikan host authorizes secret names and destination hosts for a lease.
2. It sends the worker a short-lived, single-use encrypted/wrapped bundle over
   authenticated transport, never the complete conversation vault.
3. The worker validates lease ID, fencing epoch, expiry, and intended secret
   paths before unwrapping.
4. It keeps real values in memory and gives Gondolin only placeholder mappings
   plus destination policy.
5. Lease release, expiry, or reassignment removes the mappings and revokes any
   renewable credentials.

HashiCorp Vault response wrapping is a reliable optional implementation: its
token is single-use, separately expiring, and supports lookup of creation path
before unwrap. If mikan retains its file-backed vault, mikan must implement the
equivalent scoped envelope and audit semantics itself.
([Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping))

File credentials are a compatibility exception. Project only explicitly allowed
files into a lease-specific scratch provider, prefer read-only access, never
mount the whole vault, and wipe the scratch state on release. Once a real secret
file enters the guest, Gondolin's non-exposure guarantee no longer applies.

## Platform support policy

### Linux

Linux with KVM should be the production worker baseline. Worker VMs must expose
`/dev/kvm`; a cloud VM without nested virtualization or KVM passthrough will fall
back to TCG or fail. The worker readiness check must verify the active
accelerator, not merely that QEMU is installed. Apply cgroup v2 limits to each
QEMU process for resource enforcement.

### macOS

macOS with HVF is a valid local-development and small-worker target. Gondolin
aims to keep guest-visible behavior aligned with Linux and documents both Apple
Silicon and supported Intel Macs. ([Gondolin QEMU backend](https://earendil-works.github.io/gondolin/qemu/))

Do not claim identical production resource isolation initially. Gondolin itself
does not provide complete resource governance, and the researched foundations do
not supply a cgroup-v2-equivalent contract on macOS. Qualify macOS production
support through the same conformance, load, failure, and security tests rather
than assuming QEMU backend parity implies operational parity.

## Main risks and controls

| Risk                                               | Consequence                                            | Required control                                                               |
| -------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Gondolin remains pre-1.0 and explicitly early      | API or behavior changes                                | Pin exact version, wrap it, maintain Linux/macOS contract tests                |
| mikan Node version is below Gondolin's requirement | In-process integration cannot run on supported minimum | Separate Node 24 worker or explicitly raise mikan's minimum                    |
| Worker partition after reassignment                | Two VMs write the same workspace                       | Lease expiry plus fencing epoch enforced by worker and workspace finalizer     |
| Shared filesystem cache/lock assumptions           | Stale reads or conflicting writes                      | Single writer, generation markers, filesystem-specific failure tests           |
| Retried `exec` after lost response                 | Duplicate shell side effects                           | Request IDs and result journal; document at-least-once semantics               |
| Worker compromise                                  | Exposure of lease-scoped host secrets/workspace        | Least-privilege workers, short-lived bundles, allowlists, no full vault copy   |
| Guest gets file credentials                        | Secret can be read and exfiltrated                     | Explicit compatibility policy, narrow egress, short-lived credentials, cleanup |
| QEMU/Gondolin DoS gap                              | Host resource exhaustion                               | Linux cgroups, capacity admission, output/disk/time limits, worker watchdog    |
| Guest asset drift                                  | Checkpoint cannot resume or behavior changes           | Content/build IDs, signed or checksum-verified image promotion, staged rollout |
| Network incompatibility                            | Tools requiring HTTP/2, UDP, or arbitrary TCP fail     | Curated supported tool/profile list and conformance tests                      |
| VFS semantic/performance differences               | Package managers, watchers, or large trees regress     | Real-workload benchmarks and repository operation test suite                   |

## Phased recommendation

### Phase 0: compatibility spike

- Run a separate Node 24 worker using a pinned Gondolin release.
- Test Linux x86_64, Linux ARM64, and current supported macOS hardware with
  hardware acceleration verified.
- Exercise mikan's actual `bash`, read, write, edit, package install, Git,
  cancellation, large output, private workspace, and vault HTTP flows.
- Benchmark VM cold start, warm exec, VFS operations, and a representative
  package install; kill QEMU and the worker during writes.
- Produce a curated guest image and verify its manifest/checksums.

Exit only if the required mikan workflows pass without generic NAT, arbitrary
Docker images, or unsafe secret-file mounts.

### Phase 1: single machine through the worker protocol

- Route all new `microvm` execution through `WorkerClient`, even locally.
- Run `mikan-worker` over a Unix socket on the same machine.
- Use `local-path` workspace preparation and mikan-host-authorized scoped secrets.
- Implement lifecycle reconciliation, idle stop, request IDs, profiles, and
  worker readiness checks.
- Keep `image:*` as a transitional Docker fallback.

This phase creates the single-to-multi seam before any distributed storage is
introduced.

### Phase 2: one remote Linux worker

- Add authenticated remote transport, heartbeats, durable leases, fencing, and
  capacity reporting.
- Start with shared POSIX storage so workspace startup does not require bulk
  transfer.
- Deliver only lease-scoped secret bundles; apply Linux cgroup limits.
- Test host restart, worker restart, partition, storage interruption, expired
  secret, duplicate request, and stale lease behavior.

### Phase 3: multiple Linux workers

- Add sticky placement, queueing, draining, image/profile rollout, and
  reconciliation across workers.
- Keep one writable worker per conversation workspace.
- Add Git/worktree caching for source repositories if shared-storage latency is
  measured to be a problem.
- Treat failover as VM recreation from committed workspace state, not live
  migration.

### Phase 4: qualify macOS workers and advanced workspace sync

- Run the same conformance and failure suite on macOS/HVF.
- Define lower or best-effort resource guarantees where OS controls differ.
- Add content-addressed workspace generations only if non-Git remote workloads
  justify the maintenance cost.

### Phase 5: narrow the supported sandbox set

- Make `microvm:<profile>` the managed default.
- Keep `host` for trusted local use.
- Deprecate `image:*` after workload, secret, workspace, and operational parity
  is demonstrated for the curated profiles.
- Do not expose `qemu:*` as a user-facing mode; QEMU is a backend detail.
- Do not add Firecracker to the default matrix. It is Linux/KVM-only and would
  create a second control stack. ([Firecracker repository](https://github.com/firecracker-microvm/firecracker))

## Decision

Use Gondolin/QEMU as the local sandbox engine, with QEMU as the mature isolation
foundation and Gondolin as a pinned, replaceable adapter. Build one mikan worker
protocol and run it locally from the first release. For the first remote version,
use one Linux/KVM worker plus shared POSIX storage, scoped in-memory secrets, and
strict leases/fencing. Add worker-local Git caching only after measurement.

The architecture is feasible and friendly to growing teams because moving from
one machine to several changes placement and workspace providers, not the agent,
executor, vault policy, or sandbox profile. The hard boundary is clear: Gondolin
solves local controlled execution; mikan must own reliable distributed state.

## Primary sources

### mikan

- `src/execution-resolver.ts`
- `src/provisioner.ts`
- `src/sandbox/container.ts`
- `src/sandbox/image.ts`
- `src/vault/index.ts`
- `src/vault/routing.ts`
- `src/commands/sandbox.ts`
- `src/tools/sandbox.ts`
- `src/content/docs/sandbox.mdx`
- `src/content/docs/sandbox/image.md`
- `src/content/docs/sandbox/vault.md`

### Gondolin

- [Repository and README](https://github.com/earendil-works/gondolin)
- [Published releases](https://github.com/earendil-works/gondolin/releases)
- [Host package metadata](https://github.com/earendil-works/gondolin/blob/main/host/package.json)
- [CI workflow](https://github.com/earendil-works/gondolin/blob/main/.github/workflows/ci.yml)
- [Architecture](https://earendil-works.github.io/gondolin/architecture/)
- [Security design](https://earendil-works.github.io/gondolin/security/)
- [QEMU backend](https://earendil-works.github.io/gondolin/qemu/)
- [Backend capability matrix](https://earendil-works.github.io/gondolin/backends/)
- [VM lifecycle and execution](https://earendil-works.github.io/gondolin/sdk-vm/)
- [VFS providers](https://earendil-works.github.io/gondolin/vfs/)
- [Secret handling](https://earendil-works.github.io/gondolin/secrets/)
- [Snapshots](https://earendil-works.github.io/gondolin/snapshots/)
- [Workload lifecycle](https://earendil-works.github.io/gondolin/workloads/)
- [Custom images](https://earendil-works.github.io/gondolin/custom-images/)
- [Current limitations](https://earendil-works.github.io/gondolin/limitations/)

### Platform, workspace, and secrets

- [QEMU virtualization accelerators](https://www.qemu.org/docs/master/system/introduction.html)
- [QEMU security model](https://www.qemu.org/docs/master/system/security.html)
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [NFSv4.1 protocol and caching](https://www.rfc-editor.org/rfc/rfc8881.html#section-10)
- [Git worktree](https://git-scm.com/docs/git-worktree.html)
- [Git partial clone](https://git-scm.com/docs/partial-clone)
- [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)
- [Firecracker repository](https://github.com/firecracker-microvm/firecracker)
