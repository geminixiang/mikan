# Linux amd64 k3s quickstart

This profile is rendered and checked in CI but has not yet completed the same
end-to-end hardware test as GKE. Use an amd64 Linux host with KVM. Kata and RWX
storage installation are cluster-specific prerequisites, not resources managed
by the mikan chart.

## 1. Verify the host and k3s

```bash
uname -m
test -e /dev/kvm && ls -l /dev/kvm
kubectl get nodes -o wide
kubectl get node -o jsonpath='{.items[0].status.nodeInfo.containerRuntimeVersion}{"\n"}'
```

Expected: `x86_64`, `/dev/kvm` exists, nodes are `Ready`, and k3s uses
containerd. Stop here if KVM is unavailable; do not create a fake RuntimeClass.

## 2. Get the chart

Install Helm 3 and Git, then use a source checkout:

```bash
git clone https://github.com/geminixiang/mikan.git
cd mikan
export MIKAN_CHART=deploy/helm/mikan
helm version
```

Or pull a released OCI chart:

```bash
export MIKAN_VERSION=<chart-version>
helm pull oci://ghcr.io/geminixiang/charts/mikan \
  --version "$MIKAN_VERSION" --untar --untardir /tmp/mikan-chart
export MIKAN_CHART=/tmp/mikan-chart/mikan
```

## 3. Install Kata for the k3s containerd installation

Follow the Kata Containers installation instructions for your Linux
distribution and configure the k3s-managed containerd template to register the
`kata-qemu` runtime handler. k3s regenerates containerd configuration, so do
not edit the generated `config.toml` directly.

After restarting k3s, register and verify the handler:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
EOF

kubectl get runtimeclass kata-qemu
kubectl run kata-smoke --image=busybox:1.37.0 \
  --restart=Never --overrides='{"spec":{"runtimeClassName":"kata-qemu","containers":[{"name":"kata-smoke","image":"busybox:1.37.0","command":["sleep","300"]}]}}'
kubectl wait pod/kata-smoke --for=condition=Ready --timeout=5m
kubectl exec kata-smoke -- uname -r
kubectl get node -o jsonpath='{.items[0].status.nodeInfo.kernelVersion}{"\n"}'
```

Expected: the Pod and node kernels differ. Delete the smoke Pod afterward.

## 4. Install an RWX provisioner

Install NFS CSI, Longhorn RWX, CephFS, or another provisioner supported by your
cluster. Record its StorageClass:

```bash
kubectl get storageclass
export MIKAN_RWX_STORAGE_CLASS=<your-rwx-class>
```

Verify it supports concurrent mounts; the chart deliberately has no guessed
k3s StorageClass default.

## 5. Install Agent Sandbox controller/extensions

```bash
kubectl apply -f \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox-with-extensions.yaml
kubectl -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=10m
kubectl get crd | grep agents.x-k8s.io
```

Expected: the controller is Ready and Sandbox/SandboxTemplate/SandboxClaim CRDs
exist.

## 6. Install the router

```bash
helm upgrade --install mikan-router "$MIKAN_CHART" \
  --namespace agent-sandbox-system --create-namespace \
  -f "$MIKAN_CHART/values-router.yaml" \
  --set router.clientNamespace=mikan

kubectl -n agent-sandbox-system rollout status \
  deployment/sandbox-router --timeout=5m
```

Expected: router Deployment `Ready` and Service
`sandbox-router-svc` on port 8080.

## 7. Create credentials

```bash
kubectl create namespace mikan
kubectl -n mikan create secret generic mikan-env \
  --from-literal=SLACK_APP_TOKEN="$SLACK_APP_TOKEN" \
  --from-literal=SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

## 8. Install mikan

```bash
helm upgrade --install mikan "$MIKAN_CHART" \
  --namespace mikan \
  -f "$MIKAN_CHART/values-k3s.yaml" \
  --set storage.workspace.storageClassName="$MIKAN_RWX_STORAGE_CLASS"

kubectl -n mikan rollout status deployment/mikan-mikan --timeout=10m
kubectl -n mikan get pods,pvc,sandboxtemplates,sandboxwarmpools
```

The install fails early if `kata-qemu`, Agent Sandbox CRDs, or an explicit RWX
StorageClass is missing.

## 9. End-to-end smoke test

Ask the bot to run:

```text
uname -r
```

While it runs:

```bash
kubectl -n mikan get sandboxclaims,sandboxes,pods,services -w
```

Expected:

1. A SandboxClaim and Sandbox become Ready.
2. The Sandbox Pod uses `runtimeClassName: kata-qemu`.
3. The response kernel differs from the k3s node kernel.

Then test browser/recording tools:

```text
Run chromium --version, playwright --version, and ffmpeg -version.
```

## 10. Troubleshoot

```bash
kubectl -n mikan describe sandboxclaim <claim>
kubectl -n mikan describe pod <sandbox-pod>
kubectl -n agent-sandbox-system logs deployment/sandbox-router --tail=200
kubectl -n agent-sandbox-system logs deployment/agent-sandbox-controller --tail=200
```

- Pod `Pending`: check RuntimeClass scheduling and node KVM support.
- PVC `Pending`: check the selected RWX provisioner.
- Router `502`: confirm the per-Sandbox headless Service exists and NetworkPolicy
  permits traffic from namespace `mikan`.

## 11. Cleanup

```bash
kubectl -n mikan delete sandboxclaims --all
helm uninstall mikan -n mikan
helm uninstall mikan-router -n agent-sandbox-system
kubectl -n mikan delete pvc mikan-mikan-workspace mikan-mikan-state
kubectl delete namespace mikan
```
