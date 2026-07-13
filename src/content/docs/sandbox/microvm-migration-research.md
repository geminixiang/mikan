---
title: MicroVM sandbox migration research
description: Research notes for moving mikan's managed image sandbox contract to Gondolin/QEMU-style microVMs.
---

Generated: 2026-07-13

## Question

mikan's strongest sandbox mode today is `image:<image>`, which is implemented as
mikan-managed Docker containers. The target direction is to reduce the supported
sandbox matrix and move the important `image:*` contract to a smaller set of
specialized microVM-based runtimes, with at least:

- single-machine deployment
- multi-machine deployment
- Linux and macOS support
- vault secret injection
- workspace projection equivalent to the current private/full workspace modes

## Current mikan contract to preserve

The important behavior is not the `image:*` parser itself. `src/sandbox/image.ts`
only parses and validates a Docker image name. The real contract is split across
`src/execution-resolver.ts`, `src/provisioner.ts`, `src/sandbox/container.ts`,
`src/vault/index.ts`, and the `/pi-sandbox` command/tool.

`image:*` currently means:

- one conversation vault key maps to one managed runtime
- vault key normalization is shared with the managed container name
- mikan creates, starts, stops, recreates, and reconciles runtimes
- each runtime gets an isolated Docker bridge network
- the private workspace mode exposes only `MEMORY.md`, `skills/`, `events/`,
  and the current conversation directory at `/workspace`
- the full workspace mode exposes the whole host workspace at `/workspace`
- vault env is injected at command execution time
- vault file credentials are projected into the runtime as writable mounts
- CPU/memory defaults, boost limits, and temporary per-conversation limit
  overrides are supported
- idle managed runtimes are stopped
- container drift is detected from bind mounts, mount fingerprints, and network
  mode, then repaired by recreation

The existing user-facing documentation says the same thing: `image:<image>` is
the only current mode that combines mikan-managed lifecycle, automatic workspace
mounts, automatic vault file projection, private workspace mode, idle stopping,
and resource limit controls.

## External findings

### Gondolin/QEMU is the best first target

[Gondolin](https://github.com/earendil-works/gondolin) is explicitly an agent
sandbox: local Linux microVMs with host-side filesystem and network policy
control. Its architecture is a TypeScript/Node host library plus CLI, a minimal
Linux guest, and a VM backend, with QEMU as the default backend and `libkrun` as
experimental. The host controls VM lifecycle, command execution, VFS providers,
network mediation, and guest asset download/cache.

This matches mikan better than raw QEMU or raw Firecracker because mikan already
has a TypeScript host control plane and needs host-mediated exec, filesystem,
network, and secrets rather than only a VM process.

[Gondolin's README](https://github.com/earendil-works/gondolin) and
[backend matrix](https://earendil-works.github.io/gondolin/backends/) state that
Linux and macOS are supported, with QEMU as the recommended/default backend.
[QEMU's official documentation](https://www.qemu.org/docs/master/system/introduction.html)
lists KVM for Linux and Hypervisor Framework for macOS, which gives Gondolin a
credible cross-platform baseline. TCG exists as a fallback, but it is much
slower and should not be treated as a production path.

### Firecracker is not the cross-platform core

[Firecracker](https://github.com/firecracker-microvm/firecracker) is a strong
Linux microVM VMM for multi-tenant serverless/container workloads, and its README
states that it uses Linux KVM. Its tested platform list is Linux host oriented.
It is attractive for Linux fleets, but it would force mikan to own far more of
the lifecycle, workspace, secret, and network policy surface itself. It also does
not satisfy macOS support as a single core backend.

Firecracker should be considered only as a later Linux-only fleet backend if
mikan wants to invest in a separate production worker architecture.

### Gondolin's filesystem model is a better workspace primitive than bind mounts

[Gondolin VFS providers](https://earendil-works.github.io/gondolin/vfs/) expose
guest paths through host-side providers such as `RealFSProvider`,
`ReadonlyProvider`, `MemoryProvider`, and `ShadowProvider`. The guest sees normal
POSIX paths while host code decides what each path means.

This is a strong match for mikan's private workspace mode:

- `/workspace/MEMORY.md` can map to the host file
- `/workspace/skills` can map to the host skills directory
- `/workspace/events` can map to the host events directory
- `/workspace/<conversationId>` can map to the current conversation directory
- full mode can map the whole workspace through `RealFSProvider`
- sensitive workspace files can be hidden or made read-only with a policy wrapper

The major design improvement over Docker bind mounts is that mikan can express
workspace policy in host code instead of by recreating containers when bind
mounts change.

### Secret handling should change shape

Gondolin's preferred model is not to put real secrets into guest env. Its
[secrets documentation](https://earendil-works.github.io/gondolin/secrets/)
describes placeholder env values: the guest sees placeholders, and the host
substitutes real secret values only into allowed outbound HTTP(S) destinations.
The same docs explicitly warn not to pass real secrets via `VM.env` or mount host
secret files into the guest.

This is safer than the current `image:*` behavior for HTTP API tokens, but it is
not a drop-in replacement for all vault file credentials. For mikan:

- env tokens used in HTTP headers should migrate to Gondolin host-side secret
  placeholders
- file credentials such as `.ssh`, `.kube`, `gws.json`, and `gcloud-adc.json`
  need a compatibility decision
- some file credentials can be projected through a policy VFS mount, but that is
  less safe than host-mediated per-destination substitution
- SSH and non-HTTP credentials should use Gondolin's explicit SSH egress or
  mapped TCP exception paths where possible

This implies the migration should split the vault model into:

- `networkSecret`: host-held, guest placeholder, scoped to allowed hosts
- `fileCredential`: explicit projected file/directory, audited and opt-in
- `plainEnv`: compatibility-only, discouraged for secrets

### Network compatibility is the main behavioral risk

[Gondolin's network access docs](https://earendil-works.github.io/gondolin/sdk-network/)
say the default network stack mediates HTTP and TLS traffic, blocks arbitrary
non-HTTP/TLS TCP unless explicit SSH or mapped TCP rules are configured, and
does not provide generic NAT.

That is good for preventing secret exfiltration and internal network access, but
it is not Docker-equivalent. The
[limitations page](https://earendil-works.github.io/gondolin/limitations/) lists
current gaps including no HTTP/2, no HTTP/3, no QUIC, no WebRTC, and no generic
UDP in the default network model.

mikan should not sell this as "Docker image mode but more isolated". It is a
more opinionated agent sandbox. That fits the user's desired direction, but the
docs and config must make the policy visible.

### Image/package compatibility is a migration cost

The current `image:<image>` accepts arbitrary Docker image names. Gondolin
currently uses guest asset manifests and its
[custom image flow](https://earendil-works.github.io/gondolin/custom-images/)
builds Alpine-based guest images. Its limitations page says adding extra system
packages generally requires building a custom image and that the image builder
currently supports Alpine.

This means the migration cannot preserve arbitrary OCI image compatibility
without extra work. The better product shape is a curated mikan guest image plus
a small custom-image story, not a generic Docker replacement.

## Recommended sandbox set

The long-term supported set should be small:

| Mode                                                 | Keep?                                              | Purpose                                      |
| ---------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| `host`                                               | yes                                                | trusted local development and debugging      |
| `microvm:<image-or-profile>` backed by Gondolin/QEMU | yes                                                | main production/dev sandbox                  |
| `image:<image>`                                      | transitional                                       | compatibility while migrating users          |
| `container:<name>`                                   | likely remove or hide                              | legacy/self-managed Docker compatibility     |
| `firecracker:*`                                      | remove from general support                        | too self-managed and Linux-only for the core |
| `cloudflare:*`                                       | keep only as external bridge experiment, or remove | no workspace/file projection parity today    |

Naming suggestion: do not expose `qemu:*` as the main user-facing mode. Expose a
mikan concept such as `microvm:<profile>` or `gondolin:<profile>`, and keep QEMU
as the default backend detail. If `libkrun` is later useful, it can be selected
inside the same mode by a config field without expanding the public sandbox
matrix.

## Single-machine design

For a single mikan instance:

1. Add a `ManagedSandboxRuntime` interface that owns provision, exec, status,
   resource limit status, boost, stop, remove, reconcile, and idle stop.
2. Move Docker-specific lifecycle code behind a Docker implementation of that
   interface.
3. Implement a Gondolin/QEMU runtime with one VM per conversation vault key.
4. Keep `/workspace` and path context semantics identical to `image:*`.
5. Build VFS mounts from the same private/full workspace resolution code.
6. Map vault env to Gondolin secret placeholders by default.
7. Add explicit compatibility projection for selected vault files.
8. Keep the existing `Executor` shape so `bash`, `read`, `write`, and `edit`
   tools do not need a broad rewrite.

The first milestone should target command execution plus private workspace plus
placeholder env secrets. Resource limits and file credential projection can come
next because they require sharper policy choices.

## Multi-machine design

Gondolin is local-first; it does not provide a fleet scheduler. A multi-machine
mikan deployment should make mikan own the worker layer instead of stretching
Gondolin into one.

Recommended shape:

- one control-plane mikan process owns chat adapters, session routing, auth
  portal, and queueing
- N sandbox workers run on Linux or macOS hosts
- each worker can run Gondolin locally and advertises capacity, OS, architecture,
  image/profile support, and health
- conversations are sticky-routed to one worker while their VM is warm
- worker state is disposable except cached guest assets and running VM snapshots
- workspace material is synchronized intentionally, not by assuming a shared
  filesystem
- vault material is delivered to workers as encrypted scoped bundles or fetched
  from a central vault service at execution time

For workspace sync, prefer one of these two explicit models:

- Git/worktree model: worker checks out the repo or workspace ref, then writes
  conversation outputs back through a controlled patch/artifact path.
- Shared storage model: workers mount the same workspace storage, but mikan still
  applies VFS policy per conversation.

Avoid making mikan a universal sandbox platform. A worker protocol only needs
provision/exec/stop/status/logs and a small set of resource/secret/workspace
descriptors.

## Open decisions

- Should vault file credentials remain writable from inside the sandbox?
- Which vault files are allowed in the Gondolin backend by default?
- Should network egress default to deny-all except a curated allowlist, or match
  Docker's broader outbound access during migration?
- How much Docker image compatibility is actually required, given the stated
  goal to specialize rather than generalize?
- Should `image:*` continue to exist as an alias that means "managed sandbox",
  or should it remain Docker-specific during deprecation?
- Is multi-machine deployment allowed to require a central state/vault service,
  or must it work with only filesystem rsync/scp primitives?

## Recommendation

Build the next core sandbox as `microvm` backed by Gondolin/QEMU. Treat it as the
successor to `image:*`, not as another peer in the already-too-wide sandbox
matrix.

Preserve the `image:*` contract where it matters:

- per-conversation runtime
- per-conversation vault
- `/workspace` path semantics
- private/full workspace modes
- host-managed lifecycle
- resource status and boost UX

Intentionally change the secret model:

- prefer host-held placeholders and destination-scoped substitution
- make file credential projection explicit and audited
- document that arbitrary network protocols are not Docker-compatible by default

Keep Firecracker out of the default path. It is valuable for a future Linux-only
fleet backend, but choosing it now would either break macOS support or force
mikan to maintain a second sandbox stack.

## Sources

- mikan current implementation: `src/execution-resolver.ts`,
  `src/provisioner.ts`, `src/sandbox/container.ts`, `src/sandbox/image.ts`,
  `src/vault/index.ts`, `src/vault/routing.ts`, `src/commands/sandbox.ts`,
  `src/tools/sandbox.ts`
- mikan current docs: `src/content/docs/sandbox.mdx`,
  `src/content/docs/sandbox/image.md`, `src/content/docs/sandbox/vault.md`,
  `src/sandbox/README.md`
- [Gondolin README](https://github.com/earendil-works/gondolin)
- [Gondolin architecture overview](https://earendil-works.github.io/gondolin/architecture/)
- [Gondolin VM backends](https://earendil-works.github.io/gondolin/backends/)
- [Gondolin SDK: VM control](https://earendil-works.github.io/gondolin/sdk-vm/)
- [Gondolin SDK: network access](https://earendil-works.github.io/gondolin/sdk-network/)
- [Gondolin VFS providers](https://earendil-works.github.io/gondolin/vfs/)
- [Gondolin secrets handling](https://earendil-works.github.io/gondolin/secrets/)
- [Gondolin limitations](https://earendil-works.github.io/gondolin/limitations/)
- [Gondolin custom images](https://earendil-works.github.io/gondolin/custom-images/)
- [QEMU system emulation introduction](https://www.qemu.org/docs/master/system/introduction.html)
- [QEMU invocation reference](https://www.qemu.org/docs/master/system/invocation.html)
- [Firecracker README](https://github.com/firecracker-microvm/firecracker)
