---
title: Agent Sandbox + Kata
description: Run conversation-scoped tools in Kubernetes Agent Sandbox pods backed by Kata microVM isolation.
---

Agent Sandbox mode moves tool execution out of the mikan control-plane Pod and
into short-lived [Kubernetes SIGs Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
workloads. Every workload must use the `kata-qemu` RuntimeClass, giving it a
dedicated guest kernel instead of sharing the node kernel.

## Security boundary

- mikan itself runs as a normal Kubernetes Pod.
- tool commands and file operations run in an Agent Sandbox Pod.
- the Sandbox Pod must use `runtimeClassName: kata-qemu`.
- mikan checks the allocated Pod's RuntimeClass before executing a command.
- a missing or different RuntimeClass is an error; there is no runc fallback.

Kata strengthens the workload boundary, but it does not make the entire cluster
trusted. Kubernetes administrators, the router, storage backend, runtime image,
and credentials remain part of the trusted computing base.

## Request path

```text
conversation
  → mikan
  → SandboxClaim
  → Sandbox Pod (kata-qemu)
  → per-Sandbox headless Service
  → sandbox router
  → runtime API on port 8888
```

mikan reuses one in-memory Sandbox session for an actor while it remains active.
An inactive session is closed after at least 10 minutes; cleanup runs every 10
minutes. Graceful shutdown also closes live sessions.

## Workspace and credentials

mikan and Sandbox Pods mount the same `/workspace` PVC. Agent Sandbox mode
therefore requires `ReadWriteMany` storage; the Helm chart rejects an RWO
workspace when this mode is enabled.

Conversation-scoped vault environment variables are injected into commands.
Vault file credentials are copied into the Sandbox on first use. They are not
stored in the `SandboxTemplate`.

The runtime image includes the normal coding tools plus Chromium, Playwright,
Xvfb, ffmpeg, and ffprobe for browser automation and recording.

## Configuration

The command-line mode names a `SandboxWarmPool`:

```text
--sandbox=agent-sandbox:<warm-pool-name>
```

The corresponding `settings.json` section configures how mikan reaches and
validates the Sandbox:

```json
{
  "sandbox": {
    "agentSandbox": {
      "namespace": "mikan",
      "runtimeClassName": "kata-qemu",
      "apiUrl": "http://sandbox-router-svc.agent-sandbox-system.svc:8080",
      "routerNamespace": "agent-sandbox-system",
      "sandboxReadyTimeout": 300
    }
  }
}
```

Normally you should not create this configuration manually. The Helm GKE and
k3s profiles create `settings.json`, the `SandboxTemplate`, the
`SandboxWarmPool`, RBAC, PVC mounts, and the matching command-line argument.
With release name `mikan`, the default warm-pool name is `mikan-mikan-kata`.

## Deployment paths

Use the Helm chart as the deployment interface:

- [GKE Standard quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-gke.md) — validated with Intel N2, nested virtualization, `kata-qemu`, Filestore CSI, browser tools, Slack, and an LLM.
- [Linux amd64 k3s quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-k3s.md) — requires user-installed Kata and an existing RWX StorageClass; the project has not yet completed the same hardware E2E validation as GKE.
- [Colima quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-colima.md) — defaults to host mode and does not claim Kata isolation.

The chart does not install Kubernetes, Kata, CSI drivers, or Agent Sandbox CRDs.
Those cluster-level prerequisites must exist before enabling Agent Sandbox.

## Verify microVM isolation

Ask mikan to run `uname -r`, then compare the result with the node kernel:

```bash
kubectl get nodes -o wide
kubectl -n mikan get sandboxclaims,sandboxes,pods,services
kubectl -n mikan get pod <sandbox-pod> \
  -o jsonpath='{.spec.runtimeClassName}{"\n"}'
kubectl -n mikan exec <sandbox-pod> -- uname -r
kubectl -n mikan exec <sandbox-pod> -- findmnt /workspace
```

Success means:

1. the Sandbox Pod reports `kata-qemu`;
2. its kernel differs from the Kubernetes node kernel; and
3. the shared workspace is mounted inside the guest, typically through
   `virtiofs` on the validated GKE path.

## Operational limits

- The pinned router uses request-level `allow-all` authorization. Its
  NetworkPolicy restricts the client namespace, but hostile multi-tenant
  clusters should add TokenReview or mTLS.
- A router rollout can leave an existing SDK port-forward process alive but
  unusable. Recreate the client handle or restart mikan.
- Externally deleting a live SandboxClaim leaves mikan's in-memory handle stale
  until idle cleanup or restart. Prefer graceful shutdown and managed cleanup.
- Runtime and router images are currently published and tested for amd64. arm64
  users must provide compatible images and validate Kata independently.

See the [Helm chart reference](https://github.com/geminixiang/mikan/tree/main/deploy/helm/mikan)
for image pinning, resources, warm-pool sizing, storage retention, and router
configuration.
