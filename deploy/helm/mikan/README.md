# mikan Helm chart

This is the supported Kubernetes deployment interface for mikan. One chart
covers GKE Standard, Linux amd64 k3s, and Colima without silently weakening
sandbox isolation.

## Support matrix

| Environment     | mikan     | Agent Sandbox                 | Kata                    | Workspace storage        |
| --------------- | --------- | ----------------------------- | ----------------------- | ------------------------ |
| GKE Standard    | supported | supported                     | tested with `kata-qemu` | Filestore CSI            |
| Linux amd64 k3s | supported | supported after prerequisites | install Kata first      | existing RWX class       |
| Colima          | supported | optional                      | not assumed             | default RWO in host mode |

The default values run mikan in `host` mode inside its Pod. GKE and k3s
profiles explicitly enable Agent Sandbox after their cluster prerequisites are
installed. The chart does not install Kubernetes, Kata, CSI drivers, or the
Agent Sandbox controller/CRDs. `agentSandbox.enabled=true` always requires
`kata-qemu`; mikan does not fall back to runc.

## Images and chart releases

The defaults use public GHCR images. Override `repository`, `tag`, or `digest`
for forks and production pinning. When `digest` is set, it wins over `tag`.
An empty tag follows the chart `appVersion`, so an OCI release chart selects the
matching image release.

The mikan control-plane image is published for amd64 and arm64. The Agent
Sandbox runtime and pinned router are currently published and tested only for
amd64; arm64 clusters must provide compatible override images and validate Kata
and browser workloads independently.

Release charts are published to:

```text
oci://ghcr.io/geminixiang/charts/mikan
```

Install a packaged release with `helm install ... --version <version>`, or use
the repository path shown below while developing from source.

## Credentials

Create Secrets before installing. Do not put credentials in values files:

```bash
kubectl create namespace mikan
kubectl -n mikan create secret generic mikan-env \
  --from-literal=SLACK_APP_TOKEN=... \
  --from-literal=SLACK_BOT_TOKEN=...
kubectl -n mikan create secret generic mikan-harness-auth \
  --from-file=auth.json="$HOME/.pi/agent/auth.json"
```

Pass `--set secrets.harnessAuth.existingSecretName=mikan-harness-auth`, or set
provider API keys in `mikan-env` instead.

## GKE Standard

Prerequisites:

1. Intel N2 Ubuntu containerd node pool with nested virtualization.
2. Kata and the `kata-qemu` RuntimeClass.
3. GKE Filestore CSI addon.
4. Agent Sandbox controller/extensions v0.5.2.

```bash
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox-with-extensions.yaml

helm upgrade --install mikan-router deploy/helm/mikan \
  --namespace agent-sandbox-system --create-namespace \
  -f deploy/helm/mikan/values-router.yaml \
  --set router.clientNamespace=mikan

helm upgrade --install mikan deploy/helm/mikan \
  --namespace mikan \
  -f deploy/helm/mikan/values-gke.yaml \
  --set storage.workspace.gkeFilestore.network=my-gke-vpc \
  --set secrets.harnessAuth.existingSecretName=mikan-harness-auth
```

Filestore defaults to the `default` VPC when `network` is omitted. The chart
fails rendering instead of allowing that unsafe default.

## Linux amd64 k3s

Install Agent Sandbox, Kata, `kata-qemu`, a router, and an RWX provisioner such
as NFS or Longhorn before installing. Set your StorageClass:

```bash
helm upgrade --install mikan deploy/helm/mikan \
  --namespace mikan --create-namespace \
  -f deploy/helm/mikan/values-k3s.yaml \
  --set storage.workspace.storageClassName=my-rwx-class
```

## Colima

The Colima profile runs mikan in its Pod without claiming Kata isolation. The
mikan image includes the basic shell, Git, Node, npm, and ripgrep tools needed
for local validation, but not the browser/gcloud toolset from the Agent Sandbox
runtime image:

```bash
helm upgrade --install mikan deploy/helm/mikan \
  --namespace mikan --create-namespace \
  -f deploy/helm/mikan/values-colima.yaml
```

Only enable Agent Sandbox on Colima after independently verifying that
`kata-qemu` and RWX storage work in that Colima VM.

## Router compatibility

The chart's optional router is built from the pinned v0.5.2 source commit,
disables the cluster-wide Pod cache, and uses per-Sandbox Service DNS. It
includes the `app=sandbox-router` label required by the v0.5.2
extensions-managed NetworkPolicy. `SandboxTemplate.spec.service` therefore
remains enabled.

A router NetworkPolicy is enabled by default and allows proxy traffic only from
`router.clientNamespace` (`mikan` by default). Set it to the namespace where
mikan runs. The upstream router still uses `allow-all` request authorization;
clusters with untrusted workloads should evaluate TokenReview or mTLS before
using this deployment as a multi-tenant security boundary.

## Validation and cleanup

For offline rendering, disable live cluster checks:

```bash
helm template mikan deploy/helm/mikan \
  -f deploy/helm/mikan/values-gke.yaml \
  --set validation.clusterPrerequisites=false \
  --set storage.workspace.gkeFilestore.network=my-vpc
```

Delete active claims before uninstalling. PVCs carry Helm's `keep` policy by
default, so uninstalling the release does not destroy workspace or state data:

```bash
kubectl -n mikan delete sandboxclaims --all
helm uninstall mikan -n mikan
kubectl -n mikan delete pvc mikan-mikan-workspace mikan-mikan-state
kubectl delete storageclass mikan-mikan-filestore-rwx
```

Adjust PVC and StorageClass names when using `fullnameOverride` or an existing
claim. Deleting a dynamically provisioned PVC applies its StorageClass reclaim
policy; confirm the Filestore instance is gone before considering cleanup
complete. Set `storage.retainClaims=false` only when uninstall-time data
deletion is intended.

## Known recovery limits

- The pinned SDK does not recover a still-running `kubectl port-forward`
  process after the router endpoint rolls over. Recreate the client handle.
- Externally deleting a live claim leaves mikan's in-memory handle stale until
  managed idle cleanup or process restart. Prefer graceful shutdown.
