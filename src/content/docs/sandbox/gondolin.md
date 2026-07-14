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

Each conversation gets a process-local VM, and the current host workspace is mounted read-write at `/workspace`. Commands and file tools run inside that VM with `TZ=Asia/Taipei`.

## Preview limitations

This local slice deliberately does not inject vault environment variables or vault files. It also has no private workspace mode, resource limits, boost, durable lease, worker process, or remote execution. Idle VMs close after 10 minutes and are recreated on the next operation. `image:*` remains available and is still the recommended managed mode until the remaining controls are implemented.

Gondolin's network model is controlled HTTP/TLS rather than Docker-style generic NAT. See [MicroVM migration research](./gondolin-migration-research/) for the compatibility and migration plan.
