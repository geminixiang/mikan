#!/usr/bin/env bash
set -euo pipefail

chart="${1:-deploy/helm/mikan}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

for quickstart in quickstart-gke.md quickstart-k3s.md quickstart-colima.md; do
  test -s "$chart/docs/$quickstart"
done
for profile in values-gke.yaml values-k3s.yaml values-colima.yaml values-router.yaml; do
  test -s "$chart/$profile"
done

helm lint "$chart" --set validation.clusterPrerequisites=false
helm template default "$chart" --set validation.clusterPrerequisites=false > "$work_dir/default.yaml"
helm template colima "$chart" -f "$chart/values-colima.yaml" \
  --set validation.clusterPrerequisites=false > "$work_dir/colima.yaml"
helm template mikan "$chart" -f "$chart/values-gke.yaml" \
  --set validation.clusterPrerequisites=false \
  --set storage.workspace.gkeFilestore.network=ci-vpc > "$work_dir/gke.yaml"
helm template k3s "$chart" -f "$chart/values-k3s.yaml" \
  --set validation.clusterPrerequisites=false \
  --set storage.workspace.storageClassName=ci-rwx > "$work_dir/k3s.yaml"
helm template router "$chart" --namespace agent-sandbox-system \
  -f "$chart/values-router.yaml" > "$work_dir/router.yaml"
helm template digest "$chart" \
  --set validation.clusterPrerequisites=false \
  --set mikan.image.tag=wrong \
  --set mikan.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  > "$work_dir/digest.yaml"

for manifest in "$work_dir"/*.yaml; do
  test -s "$manifest"
done

# Custom resources still require API discovery even with --dry-run=client.
# Developers can opt into this extra check when a suitable cluster is active.
if [[ "${HELM_KUBECTL_DRY_RUN:-0}" == "1" ]]; then
  for manifest in "$work_dir"/*.yaml; do
    kubectl apply --dry-run=client -f "$manifest" >/dev/null
  done
fi

! grep -qE '^kind: (SandboxTemplate|Role)$' "$work_dir/default.yaml"
! grep -qE '^kind: (SandboxTemplate|Role)$' "$work_dir/colima.yaml"
grep -q 'kind: SandboxTemplate' "$work_dir/gke.yaml"
grep -q 'kind: SandboxTemplate' "$work_dir/k3s.yaml"
grep -q 'kind: NetworkPolicy' "$work_dir/router.yaml"
! grep -q 'kind: ClusterRole' "$work_dir/router.yaml"
grep -q 'ghcr.io/geminixiang/mikan@sha256:aaaaaaaa' "$work_dir/digest.yaml"
grep -q 'name: mikan-mikan-filestore-rwx' "$work_dir/gke.yaml"
grep -q 'deployment/mikan-mikan' "$chart/docs/quickstart-gke.md"
grep -q 'mikan-mikan-workspace' "$chart/docs/quickstart-gke.md"
grep -q 'deployment/mikan-mikan' "$chart/docs/quickstart-colima.md"

if helm template invalid "$chart" -f "$chart/values-gke.yaml" \
  --set validation.clusterPrerequisites=false >/dev/null 2>&1; then
  echo "GKE profile unexpectedly accepted a missing VPC" >&2
  exit 1
fi
if helm template invalid "$chart" -f "$chart/values-k3s.yaml" \
  --set validation.clusterPrerequisites=false >/dev/null 2>&1; then
  echo "k3s profile unexpectedly accepted a missing RWX StorageClass" >&2
  exit 1
fi
if helm template invalid "$chart" \
  --set validation.clusterPrerequisites=false \
  --set agentSandbox.enabled=true \
  --set mikan.sandbox.mode=agent-sandbox \
  --set agentSandbox.runtimeClassName=runc >/dev/null 2>&1; then
  echo "chart unexpectedly accepted a non-Kata RuntimeClass" >&2
  exit 1
fi
if helm template invalid "$chart" \
  --set validation.clusterPrerequisites=false \
  --set storage.workspace.create=false >/dev/null 2>&1; then
  echo "chart unexpectedly accepted create=false without an existing PVC" >&2
  exit 1
fi

echo "Helm profile checks passed"
