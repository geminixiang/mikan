---
title: Agent Sandbox + Kata
description: 使用 Kubernetes Agent Sandbox 和 Kata microVM 隔离运行每个会话的工具。
---

Agent Sandbox 模式将工具执行移出 mikan control-plane Pod，放入短期运行的
[Kubernetes SIGs Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
工作负载。每个工作负载都必须使用 `kata-qemu` RuntimeClass，从而拥有独立的 guest
kernel，而不是与节点共享 kernel。

## 安全边界

- mikan 本身作为普通 Kubernetes Pod 运行。
- 工具命令和文件操作在 Agent Sandbox Pod 中执行。
- Sandbox Pod 必须使用 `runtimeClassName: kata-qemu`。
- mikan 会在执行命令前检查实际分配的 Pod RuntimeClass。
- RuntimeClass 缺失或不符时会直接失败，不会回退到 runc。

Kata 加强的是工作负载边界，并不代表整个集群都可信。Kubernetes 管理员、router、
storage backend、runtime image 和 credentials 仍属于 trusted computing base。

## 请求路径

```text
conversation
  → mikan
  → SandboxClaim
  → Sandbox Pod (kata-qemu)
  → 每个 Sandbox 的 headless Service
  → sandbox router
  → 端口 8888 上的 runtime API
```

actor 保持活跃时，mikan 会复用同一个内存 Sandbox session。session 闲置至少 10 分钟
后关闭，cleanup 每 10 分钟运行一次；graceful shutdown 也会关闭 live sessions。

## Workspace 和 credentials

mikan 与 Sandbox Pods 挂载同一个 `/workspace` PVC。因此 Agent Sandbox 模式要求
`ReadWriteMany` storage；启用此模式时，Helm chart 会拒绝 RWO workspace。

Conversation-scoped vault 环境变量会注入命令。Vault 文件凭证在首次使用时复制到
Sandbox，不会存入 `SandboxTemplate`。

runtime image 包含常规 coding tools，以及 Chromium、Playwright、Xvfb、ffmpeg 和
ffprobe，可用于 browser automation 与录制。

## 配置

CLI mode 指向一个 `SandboxWarmPool`：

```text
--sandbox=agent-sandbox:<warm-pool-name>
```

对应的 `settings.json` 配置 mikan 如何连接和验证 Sandbox：

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

通常不应手动创建这些配置。Helm 的 GKE 和 k3s profiles 会生成
`settings.json`、`SandboxTemplate`、`SandboxWarmPool`、RBAC、PVC mounts 以及匹配的
CLI argument。release name 为 `mikan` 时，默认 warm pool 名称是
`mikan-mikan-kata`。

## 部署路径

请使用 Helm chart 作为正式部署接口：

- [GKE Standard quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-gke.md)：已验证 Intel N2、nested virtualization、`kata-qemu`、Filestore CSI、browser tools、Slack 和 LLM。
- [Linux amd64 k3s quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-k3s.md)：需要用户安装 Kata 并提供现有 RWX StorageClass；目前尚未完成与 GKE 相同的真实硬件 E2E。
- [Colima quickstart](https://github.com/geminixiang/mikan/blob/main/deploy/helm/mikan/docs/quickstart-colima.md)：默认使用 host mode，不宣称 Kata 隔离。

Chart 不安装 Kubernetes、Kata、CSI driver 或 Agent Sandbox CRDs。启用 Agent Sandbox
之前，这些集群前提条件必须已经存在。

## 验证 microVM 隔离

让 mikan 执行 `uname -r`，然后与节点 kernel 比较：

```bash
kubectl get nodes -o wide
kubectl -n mikan get sandboxclaims,sandboxes,pods,services
kubectl -n mikan get pod <sandbox-pod> \
  -o jsonpath='{.spec.runtimeClassName}{"\n"}'
kubectl -n mikan exec <sandbox-pod> -- uname -r
kubectl -n mikan exec <sandbox-pod> -- findmnt /workspace
```

成功条件：

1. Sandbox Pod 报告 `kata-qemu`；
2. Sandbox kernel 与 Kubernetes 节点 kernel 不同；
3. shared workspace 已挂载到 guest；在已验证的 GKE 路径中通常显示为
   `virtiofs`。

## 运维限制

- pinned router 使用 request-level `allow-all` authorization。NetworkPolicy 只限制
  client namespace；不受信任的多租户集群应增加 TokenReview 或 mTLS。
- router rollout 可能留下仍存活但不可用的 SDK port-forward process。请重建 client
  handle 或重启 mikan。
- 从外部删除 live SandboxClaim 会使 mikan 的内存 handle stale，直到 idle cleanup
  或重启。应优先使用 graceful shutdown 和受管理的 cleanup。
- runtime 和 router images 目前只发布并测试 amd64。arm64 用户必须提供兼容 images
  并自行验证 Kata。

image pinning、resources、warm-pool sizing、storage retention 和 router 配置请参阅
[Helm chart reference](https://github.com/geminixiang/mikan/tree/main/deploy/helm/mikan)。
