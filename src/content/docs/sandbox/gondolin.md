---
title: Gondolin sandbox
description: Run mikan tools in a local Gondolin/QEMU microVM.
---

`gondolin:default` is a preview of the managed sandbox intended to replace `image:*` after its lifecycle, vault, workspace, and resource controls reach parity.

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

Each conversation gets a VM hosted by a dedicated, detached worker process; mikan talks to it over Gondolin's session IPC socket, one connection per command, so aborting or timing out a command kills it inside the guest. The default `private` workspace mode mounts only `MEMORY.md`, `skills`, `events`, and the current conversation under `/workspace`; `full` mounts the complete host workspace. Conversation vault environment variables are sent per command over the (user-only) socket and credential files are mounted into the VM. Commands and file tools run inside that VM with `TZ=Asia/Taipei`.

Because workers are detached, runtimes survive mikan restarts and deploys: on the next command for a conversation, mikan adopts the surviving worker (after checking its fingerprint and health) instead of paying a VM boot. Workers watch their own VM — if the QEMU/krun runner dies, the worker exits, and mikan recreates the runtime on the next command; a worker killed outright is detected the same way and its orphaned runner is stopped before respawning. Workers also watch a mikan heartbeat file and shut themselves down once no mikan has been around for 45 minutes.

## Preview limitations

CPU/memory defaults, temporary limits from the agent `sandbox` tool, and `/pi-sandbox boost` use the same settings and conversation scope as `image:*`. Before each operation, mikan fingerprints the resolved image build, mounts, and effective limits. When that desired configuration changes, mikan waits for active work, closes the stale VM, and creates one replacement. Temporary limits reset after its session closes. Gondolin exposes whole vCPUs, so fractional CPU values are rounded up; strict fractional quotas require host cgroup enforcement.

Every worker persists a runtime record under the state dir (`gondolin-runtimes/`), and mikan reconciles that inventory at startup: records whose worker is still alive are left for adoption, VM runners orphaned by a dead worker are verified and stopped, stale records are dropped, and Gondolin's own session registry is collected. Reconciliation is idempotent. Idle runtimes stop after 10 minutes (surviving workers that no conversation adopts are swept on the same schedule) and are recreated on the next operation.

This local slice has no remote execution — the worker runs on the same host. `image:*` remains available and is still the recommended managed mode while `gondolin:default` is in preview.

Gondolin's network model is controlled HTTP/TLS rather than Docker-style generic NAT. See [MicroVM migration research](./gondolin-migration-research/) for the compatibility and migration plan.
