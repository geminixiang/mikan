# Agent Sandbox + Kata deployment

mikan's `agent-sandbox:<warm-pool>` mode runs the mikan control plane and Agent
Sandbox workloads in the same Kubernetes cluster. Only Sandbox pods use Kata;
the mikan Deployment uses the cluster's normal runtime.

## Requirements

- Kubernetes SIGs Agent Sandbox controller and extensions. This integration is
  pinned to PR #976 commit `44382bf3134db8a7b44bf6a04cc7026b69dba17c`.
- A `kata-qemu` RuntimeClass. mikan rejects any other configured RuntimeClass
  and verifies every allocated Sandbox pod before executing commands.
- One RWX PVC mounted at `/workspace` by both mikan and each Sandbox.
- The sandbox router installed in `agent-sandbox-system` (or the namespace set
  by `sandbox.agentSandbox.routerNamespace`).
- Images for mikan and `docker/agent-sandbox-runtime/` pushed to a registry.

Install the Agent Sandbox controller from a pinned release rather than `main`:

```bash
VERSION=v0.5.2
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/sandbox-with-extensions.yaml"
```

Then edit image digests, the Filestore VPC name, and storage classes in these
manifests. Create the namespace and base resources before the namespaced
SandboxTemplate:

```bash
kubectl apply -f deploy/kubernetes/mikan.yaml
kubectl apply -f deploy/kubernetes/agent-sandbox-kata.yaml
```

Create credentials separately; do not commit platform or model credentials. The
Deployment expects platform variables in `mikan-env` and the harness auth store
in `mikan-harness-auth`:

```bash
kubectl -n mikan create secret generic mikan-env \
  --from-literal=SLACK_APP_TOKEN=... \
  --from-literal=SLACK_BOT_TOKEN=...
kubectl -n mikan create secret generic mikan-harness-auth \
  --from-file=auth.json="$HOME/.pi/agent/auth.json"
```

## GKE

Use GKE Standard with an Intel N2 Ubuntu containerd node pool and nested
virtualization. Agent Sandbox's Kata example currently excludes E2, N2D/AMD,
ARM, and COS nodes. Install Kata and the `kata-qemu` RuntimeClass following:

- https://github.com/kubernetes-sigs/agent-sandbox/tree/main/examples/kata-gke-sandbox
- https://cloud.google.com/kubernetes-engine/docs/how-to/nested-virtualization

Use a Filestore-backed RWX StorageClass for `mikan-workspace`. On a custom
VPC, set the Filestore CSI `network` parameter to the cluster VPC. If omitted,
the driver defaults to the `default` VPC; the PVC can bind while node-side NFS
mounts time out. Keep mikan's state PVC RWO because the Deployment has
`replicas: 1` and `Recreate`.

The v0.5.2 router manifests also need two compatibility details:

- Add `app: sandbox-router` to the router Pod template. The extensions-managed
  NetworkPolicy selects that label, while the upstream router Deployment only
  supplies `app.kubernetes.io/name`.
- Keep `spec.service: true` on the SandboxTemplate. PR #976's direct `apiUrl`
  transport does not send `X-Sandbox-UID`, so the router uses its per-Sandbox
  Service DNS fallback instead of the Pod-IP cache.

When building the v0.5.2 router with classic Cloud Build Docker, replace its
first `FROM --platform=$BUILDPLATFORM` with `FROM --platform=linux/amd64` in the
temporary source context. A normal `--build-arg=BUILDPLATFORM=...` is not
available while Docker parses the first `FROM`.

## Colima

Colima Kubernetes is useful for control-plane, CRD, SDK, PVC, and manifest
testing. Kata-on-Colima requires nested virtualization through the Linux VM and
is not assumed to work on every macOS/hardware combination. Do not silently
fall back to runc: if `kata-qemu` is unavailable, Sandbox creation must fail.
Run the full browser/recording/Kata validation on Linux or GKE.

Provide an RWX StorageClass, or change both manifests to a local class that
supports multi-pod mounting.

## Runtime validation

After creating one sandbox, verify:

```bash
kubectl -n mikan get sandboxclaims,sandboxes,pods
kubectl -n mikan get pod <sandbox-pod> -o jsonpath='{.spec.runtimeClassName}{"\n"}'
kubectl -n mikan exec <sandbox-pod> -- uname -r
kubectl get nodes -o custom-columns=NAME:.metadata.name,KERNEL:.status.nodeInfo.kernelVersion
```

The RuntimeClass must be `kata-qemu`, and the sandbox guest kernel should differ
from the node kernel. Then validate the target workloads:

```bash
kubectl -n mikan exec <sandbox-pod> -- bash -lc 'chromium --version || google-chrome --version'
kubectl -n mikan exec <sandbox-pod> -- bash -lc 'ffmpeg -version | head -1'
kubectl -n mikan exec <sandbox-pod> -- bash -lc 'DISPLAY=:99 ffmpeg -f x11grab -video_size 1280x720 -i :99 -t 2 /tmp/screen.mp4'
```

The runtime image supplies Playwright Chromium, Xvfb, and ffmpeg. GPU or audio
device passthrough is not configured; the initial deployment uses software
encoding and virtual display capture.

## Recovery limitations

The tested PR #976 client does not recover an existing port-forward handle after
the router Deployment rolls over: the `kubectl port-forward` process remains
alive with a dead Service endpoint connection, so subsequent requests continue
to fail. Recreate the client/Sandbox handle after router replacement.

Deleting a live SandboxClaim outside mikan similarly leaves mikan's in-memory
session pointing at the deleted claim until the process restarts or its managed
idle cleanup closes that session. Prefer graceful mikan shutdown or
`stopIdleAgentSandboxes()` over external deletion.

## Cleanup

Delete active claims before tearing down storage. The manifests use `Delete`
reclaim policies, so deleting the workspace PVC also deletes its Filestore
instance:

```bash
kubectl -n mikan delete sandboxclaims --all
kubectl -n mikan delete deployment/mikan
kubectl -n mikan delete pvc/mikan-state pvc/mikan-workspace
kubectl delete storageclass/agent-sandbox-rwx
```

Confirm the Filestore instance is gone before considering cleanup complete:

```bash
gcloud filestore instances list --project "$PROJECT"
```
