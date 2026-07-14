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

Each conversation gets a process-local VM. The default `private` workspace mode mounts only `MEMORY.md`, `skills`, `events`, and the current conversation under `/workspace`; `full` mounts the complete host workspace. Conversation vault environment variables and credential files are projected into the VM for each run. Commands and file tools run inside that VM with `TZ=Asia/Taipei`.

## Preview limitations

CPU/memory defaults, temporary limits from the agent `sandbox` tool, and `/pi-sandbox boost` use the same settings and conversation scope as `image:*`. Before each operation, mikan fingerprints the resolved image build, mounts, and effective limits. When that desired configuration changes, mikan waits for active work, closes the stale VM, and creates one replacement. Temporary limits reset after its session closes. Gondolin exposes whole vCPUs, so fractional CPU values are rounded up; strict fractional quotas require host cgroup enforcement.

mikan keeps a durable record of every VM it launches under the state dir (`gondolin-runtimes/`) and reconciles that inventory at startup: VM runner processes orphaned by a mikan process that died without cleanup are verified and stopped, stale records are dropped, and Gondolin's own session registry is collected. Reconciliation is idempotent and skips runtimes owned by another live mikan process. Idle VMs close after 10 minutes and are recreated on the next operation.

This local slice has no worker process or remote execution, and a VM does not survive a mikan restart. `image:*` remains available and is still the recommended managed mode until the remaining controls are implemented.

Gondolin's network model is controlled HTTP/TLS rather than Docker-style generic NAT. See [MicroVM migration research](./gondolin-migration-research/) for the compatibility and migration plan.
