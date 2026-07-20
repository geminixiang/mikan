---
title: Agent Sandbox + Kata
description: 使用 Kubernetes Agent Sandbox 和 Kata microVM 隔離執行各 conversation 的工具。
---

Agent Sandbox 模式會將工具執行移出 mikan control-plane Pod，放入短期運作的
[Kubernetes SIGs Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
workload。每個 workload 都必須使用 `kata-qemu` RuntimeClass，取得獨立的 guest
kernel，而不是與 node 共用 kernel。

## 安全邊界

- mikan 本身是一般 Kubernetes Pod。
- 工具指令與檔案操作在 Agent Sandbox Pod 中執行。
- Sandbox Pod 必須使用 `runtimeClassName: kata-qemu`。
- mikan 在執行指令前會檢查實際配置的 Pod RuntimeClass。
- RuntimeClass 缺失或不符時會直接失敗，不會 fallback 到 runc。

Kata 會強化 workload 邊界，但不代表整個 cluster 都可信任。Kubernetes 管理者、
router、storage backend、runtime image 與 credentials 仍屬於 trusted computing
base。

## 請求路徑

```text
conversation
  → mikan
  → SandboxClaim
  → Sandbox Pod (kata-qemu)
  → 每個 Sandbox 的 headless Service
  → sandbox router
  → port 8888 的 runtime API
```

mikan 會在 actor 仍活躍時重用同一個 in-memory Sandbox session。session 閒置至少
10 分鐘後會被關閉，cleanup 每 10 分鐘執行一次；graceful shutdown 也會關閉 live
sessions。

## Workspace 與 credentials

mikan 和 Sandbox Pods 會掛載同一個 `/workspace` PVC。因此 Agent Sandbox 模式需要
`ReadWriteMany` storage；啟用此模式時，Helm chart 會拒絕 RWO workspace。

Conversation-scoped vault environment variables 會注入指令。Vault file credentials
會在首次使用時複製進 Sandbox，不會寫入 `SandboxTemplate`。

runtime image 包含一般 coding tools，以及 Chromium、Playwright、Xvfb、ffmpeg 和
ffprobe，可用於 browser automation 與錄影。

## 設定

CLI mode 指向一個 `SandboxWarmPool`：

```text
--sandbox=agent-sandbox:<warm-pool-name>
```

對應的 `settings.json` 設定 mikan 如何連接及驗證 Sandbox：

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

一般不需要手動建立這些設定。Helm 的 GKE 與 k3s profiles 會產生
`settings.json`、`SandboxTemplate`、`SandboxWarmPool`、RBAC、PVC mounts 和對應的
CLI argument。release name 為 `mikan` 時，預設 warm pool 名稱是
`mikan-mikan-kata`。

## 部署路徑

請使用 Helm chart 作為正式部署介面：

- [GKE Standard quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-gke.md)：已驗證 Intel N2、nested virtualization、`kata-qemu`、Filestore CSI、browser tools、Slack 與 LLM。
- [Linux amd64 k3s quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-k3s.md)：需要使用者安裝 Kata 並提供既有 RWX StorageClass；目前尚未完成與 GKE 相同的真實硬體 E2E。
- [Colima quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-colima.md)：預設使用 host mode，不宣稱 Kata 隔離。

Chart 不會安裝 Kubernetes、Kata、CSI driver 或 Agent Sandbox CRDs。啟用 Agent
Sandbox 前，這些 cluster prerequisites 必須已存在。

## 驗證 microVM 隔離

請 mikan 執行 `uname -r`，再與 node kernel 比較：

```bash
kubectl get nodes -o wide
kubectl -n mikan get sandboxclaims,sandboxes,pods,services
kubectl -n mikan get pod <sandbox-pod> \
  -o jsonpath='{.spec.runtimeClassName}{"\n"}'
kubectl -n mikan exec <sandbox-pod> -- uname -r
kubectl -n mikan exec <sandbox-pod> -- findmnt /workspace
```

成功條件：

1. Sandbox Pod 回報 `kata-qemu`；
2. Sandbox kernel 與 Kubernetes node kernel 不同；
3. shared workspace 已掛載至 guest；在已驗證的 GKE 路徑通常會顯示
   `virtiofs`。

## 操作限制

- pinned router 使用 request-level `allow-all` authorization。NetworkPolicy 只限制
  client namespace；hostile multi-tenant cluster 應加入 TokenReview 或 mTLS。
- router rollout 可能留下仍存活但已無法使用的 SDK port-forward process。請重建
  client handle 或重新啟動 mikan。
- 從外部刪除 live SandboxClaim 會使 mikan 的 in-memory handle stale，直到 idle
  cleanup 或 restart。請優先使用 graceful shutdown 與受管理的 cleanup。
- runtime 與 router images 目前只發布並測試 amd64。arm64 使用者必須提供相容 images
  並自行驗證 Kata。

image pinning、resources、warm-pool sizing、storage retention 與 router 設定請參閱
[Helm chart reference](https://github.com/geminixiang/mikan/tree/main/deploy/helm/mikan)。
