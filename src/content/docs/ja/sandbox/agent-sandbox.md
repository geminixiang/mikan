---
title: Agent Sandbox + Kata
description: Kubernetes Agent Sandbox と Kata microVM 分離で conversation ごとの tools を実行します。
---

Agent Sandbox mode は tool execution を mikan control-plane Pod の外へ移し、短時間だけ
稼働する [Kubernetes SIGs Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
workload で実行します。すべての workload は `kata-qemu` RuntimeClass を使用し、node
kernel を共有する代わりに専用 guest kernel を持つ必要があります。

## Security boundary

- mikan 自体は通常の Kubernetes Pod として実行されます。
- tool commands と file operations は Agent Sandbox Pod で実行されます。
- Sandbox Pod は `runtimeClassName: kata-qemu` を使用する必要があります。
- mikan は command 実行前に、割り当てられた Pod の RuntimeClass を検査します。
- RuntimeClass がない、または異なる場合は error になり、runc へ fallback しません。

Kata が強化するのは workload boundary です。cluster 全体が信頼できるという意味では
ありません。Kubernetes administrators、router、storage backend、runtime image、
credentials は引き続き trusted computing base に含まれます。

## Request path

```text
conversation
  → mikan
  → SandboxClaim
  → Sandbox Pod (kata-qemu)
  → Sandbox ごとの headless Service
  → sandbox router
  → port 8888 の runtime API
```

actor が active な間、mikan は同じ in-memory Sandbox session を再利用します。session は
10 分以上 idle になると閉じられ、cleanup は 10 分ごとに実行されます。graceful
shutdown でも live sessions を閉じます。

## Workspace と credentials

mikan と Sandbox Pods は同じ `/workspace` PVC を mount します。そのため Agent Sandbox
mode には `ReadWriteMany` storage が必要です。この mode で RWO workspace を指定すると
Helm chart は拒否します。

Conversation-scoped vault environment variables は commands に注入されます。Vault file
credentials は初回利用時に Sandbox へ copy され、`SandboxTemplate` には保存されません。

runtime image には通常の coding tools に加え、browser automation と録画用の Chromium、
Playwright、Xvfb、ffmpeg、ffprobe が含まれます。

## Configuration

CLI mode は `SandboxWarmPool` 名を指定します：

```text
--sandbox=agent-sandbox:<warm-pool-name>
```

対応する `settings.json` は、mikan が Sandbox へ接続して検証する方法を設定します：

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

通常、この設定を手動で作成する必要はありません。Helm の GKE と k3s profiles が
`settings.json`、`SandboxTemplate`、`SandboxWarmPool`、RBAC、PVC mounts、および対応する
CLI argument を生成します。release name が `mikan` の場合、default warm-pool name は
`mikan-mikan-kata` です。

## Deployment paths

正式な deployment interface として Helm chart を使用してください：

- [GKE Standard quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-gke.md)：Intel N2、nested virtualization、`kata-qemu`、Filestore CSI、browser tools、Slack、LLM まで検証済みです。
- [Linux amd64 k3s quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-k3s.md)：user-installed Kata と既存 RWX StorageClass が必要です。GKE と同等の hardware E2E はまだ完了していません。
- [Colima quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-colima.md)：default は host mode で、Kata isolation を保証しません。

Chart は Kubernetes、Kata、CSI driver、Agent Sandbox CRDs を install しません。Agent
Sandbox を有効にする前に、これらの cluster prerequisites が必要です。

## microVM isolation の検証

mikan に `uname -r` を実行させ、node kernel と比較します：

```bash
kubectl get nodes -o wide
kubectl -n mikan get sandboxclaims,sandboxes,pods,services
kubectl -n mikan get pod <sandbox-pod> \
  -o jsonpath='{.spec.runtimeClassName}{"\n"}'
kubectl -n mikan exec <sandbox-pod> -- uname -r
kubectl -n mikan exec <sandbox-pod> -- findmnt /workspace
```

成功条件：

1. Sandbox Pod が `kata-qemu` を報告すること。
2. Sandbox kernel が Kubernetes node kernel と異なること。
3. shared workspace が guest 内に mount されていること。検証済み GKE path では通常
   `virtiofs` と表示されます。

## Operational limits

- pinned router は request-level `allow-all` authorization を使用します。NetworkPolicy は
  client namespace のみを制限します。hostile multi-tenant cluster では TokenReview または
  mTLS を追加してください。
- router rollout 後、SDK port-forward process が alive のまま利用不能になることがあります。
  client handle を再作成するか mikan を restart してください。
- live SandboxClaim を外部から削除すると、idle cleanup または restart まで mikan の
  in-memory handle が stale になります。graceful shutdown と managed cleanup を優先して
  ください。
- runtime と router images は現在 amd64 のみ publish・test されています。arm64 users は
  compatible images を用意し、Kata を独自に検証する必要があります。

image pinning、resources、warm-pool sizing、storage retention、router configuration は
[Helm chart reference](https://github.com/geminixiang/mikan/tree/main/deploy/helm/mikan) を参照
してください。
