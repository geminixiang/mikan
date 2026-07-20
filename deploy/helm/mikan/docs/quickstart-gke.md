# GKE Standard quickstart

This is the fully validated deployment path. It creates billable GKE,
Filestore, Persistent Disk, and Artifact Registry/GHCR network usage. Use a
dedicated cluster and keep project flags explicit.

## 1. Install CLIs and get the chart

Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install), its
`gke-gcloud-auth-plugin`, kubectl, Helm 3, and Git. Authenticate before creating
billable resources:

```bash
gcloud auth login
gcloud auth application-default login
git clone https://github.com/geminixiang/mikan.git
cd mikan
export MIKAN_CHART=deploy/helm/mikan
helm version
kubectl version --client
```

To use a released OCI package instead of a source checkout:

```bash
export MIKAN_VERSION=<chart-version>
helm pull oci://ghcr.io/geminixiang/charts/mikan \
  --version "$MIKAN_VERSION" --untar --untardir /tmp/mikan-chart
export MIKAN_CHART=/tmp/mikan-chart/mikan
```

## 2. Set variables and enable APIs

```bash
export PROJECT_ID=<gcp-project>
export REGION=asia-east1
export ZONE=asia-east1-a
export CLUSTER=mikan-agent-sandbox
export NETWORK=mikan-agent-sandbox
export SUBNET=mikan-agent-sandbox-${REGION}

gcloud services enable \
  container.googleapis.com \
  compute.googleapis.com \
  file.googleapis.com \
  --project "$PROJECT_ID"
```

Choose a region/zone with Intel N2 quota. The example CIDRs below must not
overlap existing networks.

## 3. Create a dedicated VPC and subnet

```bash
gcloud compute networks create "$NETWORK" \
  --project "$PROJECT_ID" \
  --subnet-mode=custom

gcloud compute networks subnets create "$SUBNET" \
  --project "$PROJECT_ID" \
  --network "$NETWORK" \
  --region "$REGION" \
  --range 10.240.0.0/24 \
  --secondary-range mikan-pods=10.241.0.0/18,mikan-services=10.242.0.0/22
```

Verify:

```bash
gcloud compute networks subnets describe "$SUBNET" \
  --project "$PROJECT_ID" --region "$REGION"
```

## 4. Create GKE Standard with nested virtualization

Create a zonal Standard cluster using an Intel N2 Ubuntu containerd node and
Dataplane V2. The initial node pool is the Kata pool for this first deployment:

```bash
gcloud container clusters create "$CLUSTER" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --release-channel regular \
  --network "$NETWORK" \
  --subnetwork "$SUBNET" \
  --cluster-secondary-range-name mikan-pods \
  --services-secondary-range-name mikan-services \
  --enable-dataplane-v2 \
  --workload-pool "${PROJECT_ID}.svc.id.goog" \
  --machine-type n2-standard-8 \
  --num-nodes 1 \
  --image-type UBUNTU_CONTAINERD \
  --disk-type pd-balanced \
  --disk-size 100 \
  --enable-nested-virtualization

gcloud container clusters get-credentials "$CLUSTER" \
  --project "$PROJECT_ID" --zone "$ZONE"
kubectl get nodes -o wide
```

Expected: one `Ready` Ubuntu node. Do not apply a strict `NoSchedule` taint to
the only node; it can prevent GKE system agents such as Konnectivity from
starting and break `kubectl exec/logs`.

## 5. Enable Filestore CSI

```bash
gcloud container clusters update "$CLUSTER" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --update-addons GcpFilestoreCsiDriver=ENABLED

kubectl get csidriver filestore.csi.storage.gke.io
kubectl -n kube-system get pods | grep filestore
```

Expected: the CSI driver exists and Filestore node Pods are Ready.

## 6. Install Kata and verify the guest kernel

Install the Kata version pinned by the Agent Sandbox v0.5.2 GKE example, then
register the runtime handler. Inspect the remote manifests before applying them
if your supply-chain policy requires vendoring:

```bash
export KATA_VERSION=3.2.0
kubectl apply -f \
  "https://raw.githubusercontent.com/kata-containers/kata-containers/${KATA_VERSION}/tools/packaging/kata-deploy/kata-rbac/base/kata-rbac.yaml"
kubectl apply -f \
  "https://raw.githubusercontent.com/kata-containers/kata-containers/${KATA_VERSION}/tools/packaging/kata-deploy/kata-deploy/base/kata-deploy.yaml"
kubectl -n kube-system rollout status daemonset/kata-deploy --timeout=10m

cat <<'EOF' | kubectl apply -f -
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
scheduling:
  nodeSelector:
    kubernetes.io/os: linux
EOF
```

Sources for these pinned instructions:

- <https://github.com/kubernetes-sigs/agent-sandbox/tree/v0.5.2/examples/kata-gke-sandbox>
- <https://cloud.google.com/kubernetes-engine/docs/how-to/nested-virtualization>

Verify the guest kernel before installing mikan:

```bash
kubectl get runtimeclass kata-qemu
kubectl run kata-smoke --image=busybox:1.37.0 \
  --restart=Never --overrides='{"spec":{"runtimeClassName":"kata-qemu","containers":[{"name":"kata-smoke","image":"busybox:1.37.0","command":["sleep","300"]}]}}'
kubectl wait pod/kata-smoke --for=condition=Ready --timeout=10m
printf 'guest: '; kubectl exec kata-smoke -- uname -r
printf 'node:  '; kubectl get node -o jsonpath='{.items[0].status.nodeInfo.kernelVersion}{"\n"}'
kubectl delete pod kata-smoke
```

Expected: guest and node kernels differ. Stop if they are identical or the Pod
uses another RuntimeClass.

## 7. Install Agent Sandbox controller/extensions

```bash
kubectl apply -f \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox-with-extensions.yaml
kubectl -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=10m
kubectl get crd | grep agents.x-k8s.io
```

Expected: controller Ready and Sandbox, SandboxTemplate, SandboxClaim, and
SandboxWarmPool CRDs installed.

## 8. Install the router

From a source checkout:

```bash
helm upgrade --install mikan-router "$MIKAN_CHART" \
  --namespace agent-sandbox-system --create-namespace \
  -f "$MIKAN_CHART/values-router.yaml" \
  --set router.clientNamespace=mikan

kubectl -n agent-sandbox-system rollout status \
  deployment/sandbox-router --timeout=5m
kubectl -n agent-sandbox-system get service sandbox-router-svc
```

Expected: router Ready on port 8080. The chart includes the legacy
`app=sandbox-router` label required by the v0.5.2 managed NetworkPolicy.

## 9. Create credentials

```bash
kubectl create namespace mikan
kubectl -n mikan create secret generic mikan-env \
  --from-literal=SLACK_APP_TOKEN="$SLACK_APP_TOKEN" \
  --from-literal=SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

Alternatively create `mikan-harness-auth` from a pi/mikan `auth.json` and set
`secrets.harnessAuth.existingSecretName` during install.

## 10. Render and install mikan

First render offline. The VPC is mandatory because Filestore otherwise defaults
to the unrelated `default` network:

```bash
helm template mikan "$MIKAN_CHART" \
  --namespace mikan \
  -f "$MIKAN_CHART/values-gke.yaml" \
  --set validation.clusterPrerequisites=false \
  --set storage.workspace.gkeFilestore.network="$NETWORK" \
  >/tmp/mikan-gke.yaml
```

Install with live prerequisite checks enabled:

```bash
helm upgrade --install mikan "$MIKAN_CHART" \
  --namespace mikan \
  -f "$MIKAN_CHART/values-gke.yaml" \
  --set storage.workspace.gkeFilestore.network="$NETWORK"

kubectl -n mikan get pods,pvc
kubectl -n mikan rollout status deployment/mikan-mikan --timeout=15m
kubectl -n mikan logs deployment/mikan-mikan --tail=100
```

The first Filestore can take several minutes. Temporary CSI messages such as
`CREATING`, `DeadlineExceeded`, or `operation already exists` may appear while
the instance is provisioning. Final gates are PVC `Bound`, mikan `Ready`, and a
Filestore instance on `$NETWORK`.

```bash
gcloud filestore instances list --project "$PROJECT_ID"
```

## 11. Run the end-to-end smoke test

Ask the bot:

```text
Use bash to run uname -r and reply with only the kernel version.
```

Observe resources:

```bash
kubectl -n mikan get sandboxclaims,sandboxes,pods,services -w
```

Expected:

1. SandboxClaim and Sandbox become Ready.
2. Sandbox Pod uses `kata-qemu`.
3. A same-name headless Service exists.
4. The reply is the Kata guest kernel, not the GKE node kernel.

Then ask it to run:

```text
Run chromium --version, playwright --version, and ffmpeg -version.
```

For direct validation:

```bash
SANDBOX_POD=$(kubectl -n mikan get pod \
  -l agents.x-k8s.io/sandbox-name-hash -o jsonpath='{.items[0].metadata.name}')
kubectl -n mikan get pod "$SANDBOX_POD" \
  -o jsonpath='{.spec.runtimeClassName}{"\n"}'
kubectl -n mikan exec "$SANDBOX_POD" -- uname -r
kubectl -n mikan exec "$SANDBOX_POD" -- findmnt /workspace
```

Expected workspace transport inside the guest: `virtiofs`.

## 12. Troubleshoot

```bash
kubectl -n mikan describe sandboxclaim <claim>
kubectl -n mikan describe pod <sandbox-pod>
kubectl -n agent-sandbox-system logs deployment/sandbox-router --tail=200
kubectl -n agent-sandbox-system logs deployment/agent-sandbox-controller --tail=200
kubectl -n kube-system logs daemonset/filestore-node \
  -c gcp-filestore-driver --tail=200
```

- Router timeout: confirm router Pods carry `app=sandbox-router` and the mikan
  namespace matches `router.clientNamespace`.
- Router DNS `no such host`: confirm `SandboxTemplate.spec.service=true` and a
  same-name headless Service exists.
- NFS timeout with PVC `Bound`: describe the Filestore instance and confirm its
  network equals `$NETWORK`.
- `kubectl exec/logs` reports no agent: inspect Pending GKE system Pods and node
  taints, especially Konnectivity.

## 13. Cleanup

PVCs and the generated StorageClass are retained by default:

```bash
kubectl -n mikan delete sandboxclaims --all
helm uninstall mikan -n mikan
helm uninstall mikan-router -n agent-sandbox-system
kubectl -n mikan delete pvc mikan-mikan-workspace mikan-mikan-state
kubectl delete storageclass mikan-mikan-filestore-rwx
kubectl delete namespace mikan

# Do not delete the cluster or VPC until this lists no instance created by the PVC.
gcloud filestore instances list --project "$PROJECT_ID"
gcloud container clusters delete "$CLUSTER" \
  --project "$PROJECT_ID" --zone "$ZONE"
gcloud compute networks subnets delete "$SUBNET" \
  --project "$PROJECT_ID" --region "$REGION"
gcloud compute networks delete "$NETWORK" --project "$PROJECT_ID"
```

Wait until the Filestore instance is gone before considering storage cleanup
complete. Cluster, node disk, control plane, Filestore, and state PD are billable
until deleted.
