# src/sandbox

This directory defines sandbox abstractions, concrete executors, and shared transport utilities.

- `agent-sandbox.ts`: Kubernetes Agent Sandbox SDK integration, actor-scoped SandboxClaim lifecycle, Kata RuntimeClass verification, vault projection, and SDK command/file transport.
- `cloudflare.ts`: Cloudflare Sandbox bridge executor.
- `container.ts`: Existing Docker container executor and managed-image runtime bootstrap.
- `host.ts`: Direct host executor.
- `image.ts`: Managed per-actor Docker image mode.
- `path-context.ts`: Host/runtime workspace mapping.
- `utils.ts`: Shared shell and file-transport helpers.

Agent Sandbox mode runs mikan and Sandbox pods in one Kubernetes cluster with a shared RWX workspace PVC. Only Sandbox pods use `kata-qemu`; mikan remains on the normal cluster runtime. See `deploy/kubernetes/README.md`.
