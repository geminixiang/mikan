# Colima quickstart

This path runs mikan in a Kubernetes Pod with the `host` executor. It is useful
for local control-plane and basic coding tests, but does not claim Kata or Agent
Sandbox isolation.

## 1. Start Colima with Kubernetes

```bash
colima start --cpu 4 --memory 8 --disk 60 --kubernetes
kubectl config use-context colima
kubectl get nodes -o wide
```

Expected: one `Ready` node. If the context has another name, select the Colima
context shown by `kubectl config get-contexts`.

## 2. Install Helm and get the chart

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

## 3. Create credentials

```bash
kubectl create namespace mikan
kubectl -n mikan create secret generic mikan-env \
  --from-literal=SLACK_APP_TOKEN="$SLACK_APP_TOKEN" \
  --from-literal=SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
```

Use any supported platform and model credentials instead of Slack/Anthropic.
Do not put secrets in a values file.

## 4. Render before installing

```bash
helm template mikan "$MIKAN_CHART" \
  --namespace mikan \
  -f "$MIKAN_CHART/values-colima.yaml" \
  --set validation.clusterPrerequisites=false >/tmp/mikan-colima.yaml

grep -- '--sandbox=host' /tmp/mikan-colima.yaml
```

Expected: `--sandbox=host`. No `SandboxTemplate` or `SandboxWarmPool` should be
rendered.

## 5. Install mikan

```bash
helm upgrade --install mikan "$MIKAN_CHART" \
  --namespace mikan \
  -f "$MIKAN_CHART/values-colima.yaml"

kubectl -n mikan rollout status deployment/mikan-mikan --timeout=5m
kubectl -n mikan get pods,pvc
kubectl -n mikan logs deployment/mikan-mikan --tail=100
```

Expected: the Deployment is `Ready`, both PVCs are `Bound`, and logs show a
connected messaging platform.

## 6. Verify local tools

```bash
kubectl -n mikan exec deployment/mikan-mikan -- \
  sh -c 'for tool in bash git rg node npm; do command -v "$tool"; done'
```

Expected: every command prints a path. The host-mode image intentionally does
not include the browser, gcloud, Xvfb, or ffmpeg toolset from the Agent Sandbox
runtime.

Send the bot a short message to verify platform and model credentials. Tool
commands run inside the mikan Pod, not a microVM.

## 7. Troubleshoot

```bash
kubectl -n mikan describe pod -l app.kubernetes.io/instance=mikan
kubectl -n mikan get events --sort-by=.lastTimestamp | tail -50
kubectl -n mikan logs deployment/mikan-mikan --previous
```

- PVC `Pending`: inspect `kubectl get storageclass`; Colima needs a default RWO
  class for this profile.
- State directory ownership error: keep `storage.fixOwnership=true`.
- Platform not active: recreate `mikan-env` with a complete credential set and
  restart the Deployment.

## 8. Cleanup

```bash
helm uninstall mikan -n mikan
kubectl -n mikan delete pvc mikan-mikan-workspace mikan-mikan-state
kubectl delete namespace mikan
colima stop
```

PVCs are retained by default, so delete them explicitly only when their data is
no longer needed.
