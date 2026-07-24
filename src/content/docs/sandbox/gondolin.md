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

Each conversation gets a VM created and owned by the mikan process itself. mikan talks to it over Gondolin's session IPC socket, one connection per command, so aborting or timing out a command kills it inside the guest — Gondolin's in-process `vm.exec()` cannot do that, because aborting it only abandons the call and leaves the guest process running. The default `private` workspace mode mounts only `MEMORY.md`, `skills`, `events`, and the current conversation under `/workspace`; `full` mounts the complete host workspace. Conversation vault environment variables are sent per command over the (user-only) socket. Commands and file tools run inside that VM with `TZ=Asia/Taipei`.

Directory mounts go through Gondolin's VFS. Single-file mounts cannot (the guest prepares every VFS mount point as a directory), so mikan projects them instead: file contents are copied into the guest at boot; files under `/workspace` (such as `MEMORY.md`) sync guest edits back to the host every couple of seconds and once more at shutdown, while vault credential files are projected owner-only (`600`) without write-back. Credential content is part of the runtime fingerprint, so rotating a credential on the host (e.g. re-running a login) recreates the runtime with a fresh projection on the conversation's next command. One consequence to know about: concurrent edits to the same projected file from two conversations are last-writer-wins rather than shared like a bind mount.

Runtimes live and die with the mikan process. Shutting mikan down (SIGINT/SIGTERM) closes every VM first, so projected files sync back and each overlay disk is released; Gondolin also SIGKILLs its VM runners from a `process.exit` hook as a backstop. A restart or deploy therefore starts cold: the first command for each conversation boots a fresh VM. The one gap is `kill -9` on mikan itself, which skips both paths and can leave a QEMU/krun runner behind for you to stop by hand. If a runner dies on its own, the session socket closes, and mikan recreates the runtime on the next command.

## Preview limitations

CPU/memory defaults, temporary limits from the agent `sandbox` tool, and `/pi-sandbox boost` use the same settings and conversation scope as `image:*`. Before each operation, mikan fingerprints the resolved image build, mounts, and effective limits. When that desired configuration changes, mikan waits for active work, closes the stale VM, and creates one replacement. Temporary limits reset after its session closes. Gondolin exposes whole vCPUs, so fractional CPU values are rounded up; strict fractional quotas require host cgroup enforcement.

At startup mikan collects Gondolin's own session registry, dropping socket files and metadata left behind by a previous run that died without cleanup. Idle runtimes stop after 10 minutes and are recreated on the next operation.

`gondolin:default` is single-host: one mikan process owns every VM it creates, and there is no remote or multi-worker mode. `image:*` remains available and is still the recommended managed mode while Gondolin is in preview.

Gondolin's network model is controlled HTTP/TLS rather than Docker-style generic NAT. See [MicroVM migration research](./gondolin-migration-research/) for the compatibility and migration plan.
