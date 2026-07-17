# CubeSandbox 多 Sandbox Worker 支援調查報告

- 調查專案：[TencentCloud/CubeSandbox](https://github.com/TencentCloud/CubeSandbox)
- 調查版本：[`70d46f16f8423ec6fb8ee6c859097de75782ef14`](https://github.com/TencentCloud/CubeSandbox/commit/70d46f16f8423ec6fb8ee6c859097de75782ef14)
- 調查日期：2026-07-15
- 方法：靜態檢視官方文件、Cubelet／CubeMaster 原始碼及官方部署配置；未實際建立叢集或執行故障注入測試。

## 結論

**CubeSandbox 原生支援多台 sandbox worker。** 專案將 worker 稱為 **compute node（計算節點）**：每台計算節點執行 Cubelet、network-agent、CubeShim／Hypervisor 等資料面元件，向 CubeMaster 註冊並接收 sandbox 建立與生命週期操作。CubeMaster 會根據節點資源、模板位置及即時建立負載進行跨節點調度。

官方提供兩種多節點部署方式：

1. 在既有單機控制節點上手動加入 N 台 compute node。
2. 透過 Tencent Cloud Terraform 建立 TKE 控制面與多台 CVM／PVM compute node。

不過，「支援多 worker」不代表目前已具備完整端到端高可用：sandbox 狀態仍是節點本地，跨節點恢復、帶 sandbox 的節點排空、線上重新平衡及自動異常恢復仍列於 roadmap。

## 1. 多節點架構

CubeSandbox 採用控制面／資料面架構：

```text
Client / SDK
    │
    ▼
CubeAPI → CubeMaster（叢集級調度）
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      Cubelet #1 Cubelet #2 Cubelet #N
          │         │         │
       Sandbox   Sandbox   Sandbox
```

- **控制面**：CubeAPI、CubeMaster、WebUI、Redis 等，負責 API、調度、狀態協調及管理。
- **資料面**：每台 compute node 執行 Cubelet、CubeShim、CubeHypervisor、網路及儲存元件，管理實際駐留於該主機的 sandbox。
- 控制節點在手動部署模式下也可同時作為 compute node。
- CubeMaster 是叢集級調度器，會選擇目標節點，再把工作下發給該節點的 Cubelet。

來源：

- [多機部署架構與 compute node 職責](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/multi-node-deploy.md#架構概覽)
- [控制面、資料面及 CubeMaster 職責](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/architecture/overview.md#控制面-vs-資料面)
- [Sandbox 建立請求中的選點流程](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/architecture/overview.md#請求生命週期)

## 2. Compute node 部署方式

### 2.1 手動加入計算節點

每台 compute node 使用與控制節點相同的 release bundle，設定：

```bash
ONE_CLICK_DEPLOY_ROLE=compute
CUBE_SANDBOX_NODE_IP=<目前節點的可路由 IP>
ONE_CLICK_CONTROL_PLANE_IP=<控制節點 IP>
```

然後執行：

```bash
sudo ./install-compute.sh
```

安裝程序會：

1. 安裝 Cubelet、network-agent、cube-shim、映像及 kernel 等執行元件。
2. 啟動 Cubelet 與 network-agent。
3. 將 Cubelet 的 `meta_server_endpoint` 指向 CubeMaster。
4. 透過 `/internal/meta` API 註冊節點並上報狀態。

控制面可透過下列 API 確認全部已註冊節點：

```bash
curl http://127.0.0.1:8089/internal/meta/nodes
```

來源：

- [多機部署步驟](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/multi-node-deploy.md#第一步準備發布包)
- [`install-compute.sh`](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/deploy/one-click/install-compute.sh)

### 2.2 Tencent Cloud Terraform

官方 Terraform 將 compute node 數量作為一級配置參數：

```bash
TENCENTCLOUD_COMPUTE_NODE_COUNT='4'
TENCENTCLOUD_COMPUTE_INSTANCE_TYPE='SA9.4XLARGE32'
TENCENTCLOUD_COMPUTE_DATA_DISK_SIZE='500'
```

官方文件的 POC 預設值是 2 台 compute node；也提供 4 台、8 台及異構跨可用區範例。Terraform 以 `count = var.compute_node_count` 建立對應數量的 CVM compute instances。

來源：

- [Terraform 節點規格與容量規劃](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/tencentcloud-terraform-deploy.md#節點規格與容量規劃)
- [Terraform compute node resource](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/deploy/one-click/terraform/tencentcloud/main.tf#L805-L839)

## 3. 節點註冊、心跳與健康狀態

Cubelet 與 CubeMaster 之間不是一次性靜態配置，而是具有正式的節點註冊及週期狀態回報機制：

- `POST /internal/meta/nodes/register`
- `POST /internal/meta/nodes/{node_id}/status`

註冊資料包含：

- node ID、host IP、Cubelet gRPC port
- CPU／記憶體 capacity 與 allocatable
- CPU／記憶體 quota
- 最大 MicroVM 數與並行建立數
- 元件版本

狀態回報包含：

- heartbeat timestamp 與 Ready condition
- 已配置資源與目前 MicroVM 數量
- 磁碟使用率
- 本地已有模板

官方 Terraform 的 Cubelet 狀態上報間隔預設為 **1 秒**。CubeMaster 會同時檢查 Ready condition 與 heartbeat 是否過期，不會把失聯節點永久視為可用。

來源：

- [Cubelet 註冊與狀態 request 定義](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/Cubelet/pkg/masterclient/client.go#L22-L71)
- [Cubelet API 呼叫](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/Cubelet/pkg/masterclient/client.go#L137-L147)
- [CubeMaster node API routes](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/CubeMaster/pkg/service/httpservice/meta/meta.go#L17-L31)
- [CubeMaster 節點健康判定](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/CubeMaster/pkg/base/nodehealth/health.go#L8-L39)

## 4. 跨 Worker 調度與負載分散

CubeMaster 的節點選擇流程包含：

1. Pre-filter／filter 排除不符合條件的節點。
2. Scorer 對候選節點評分。
3. 從分數最高的前 N 個節點中選擇目標。

預設 filter 包含：

- CPU
- 記憶體
- 模板本地性（template locality）
- 即時 sandbox 建立數量

多機指南建議啟用 `real_time_weighted_average` scorer，並以 MicroVM 數、local create 數、CPU quota 使用率及 memory quota 使用率作為權重。

重要注意事項：一般配置預設 `priority_select_num: 1`。若沒有配置 scorer，新的 sandbox 可能持續集中到第一台可用節點，直到資源 filter 將流量推往其他節點。小型多機叢集可從 `priority_select_num: 3` 開始調整。Tencent Cloud Terraform 路徑則已將 top-N 設為 `min(compute_node_count, 3)` 並啟用資源評分。

這套機制處理的是**新 sandbox placement**，不代表系統會把既有 sandbox 即時遷移到其他節點。

來源：

- [多機調度評分建議](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/multi-node-deploy.md#配置-cubemaster-調度評分)
- [CubeMaster 預設 filters](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/CubeMaster/conf.yaml#L86-L112)
- [CubeMaster scheduler 實作](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/CubeMaster/pkg/scheduler/schedule.go#L173-L238)
- [Terraform scheduler 設定](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/deploy/one-click/terraform/tencentcloud/tke-addons.tf#L33-L44)

## 5. 控制面擴展與 HA

CubeAPI 與 CubeMaster 被設計為無本機狀態，協調資訊主要透過 Redis／資料庫共享，因此架構上支援水平擴展。Cubelet 的 CubeMaster client 也接受逗號分隔的多個 endpoint，會：

- 以 round-robin 選擇每次請求的起始 endpoint。
- transport error 時嘗試下一個 endpoint。
- HTTP error 不立即切換，而留待後續 heartbeat 重試。

Terraform 可設定多個 CubeMaster／CubeAPI／CubeProxy replica；但需注意：

- 預設 replica 數均為 1，不能把預設部署視為 HA。
- CubeMaster 多副本需要共享 CFS／NFS 儲存及一致的 replica 配置。
- 官方對 cube-lifecycle-manager 的建議仍是：除非已驗證其 HA 行為，否則保持 1 replica。
- Redis、MySQL、共享檔案系統及入口負載均衡仍需納入整體 HA 設計。

來源：

- [無狀態控制面設計](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/architecture/overview.md#設計原則)
- [Cubelet 多 CubeMaster endpoint 與 failover](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/Cubelet/pkg/masterclient/client.go#L98-L127)
- [Cubelet failover 實作](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/Cubelet/pkg/masterclient/client.go#L157-L198)
- [Terraform 控制面 replica 配置](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/tencentcloud-terraform-deploy.md#節點規格與容量規劃)

## 6. 限制與風險

### 6.1 Sandbox 狀態仍是 node-local

目前每台 compute node 管理駐留於本機的 sandbox。下列能力仍列於官方 roadmap，而不是目前可依賴的既有能力：

- 跨機暫停與恢復
- 保留記憶體及檔案系統狀態的跨節點遷移
- 帶 sandbox 遷移的節點排空
- 線上資源重新平衡
- VM crash、shim 卡死或網路分區後的自動異常恢復
- 控制面與資料面完整故障隔離

因此，多 worker 可以擴充分配新 sandbox 的容量，但不能直接推論某台 worker 故障後，其既有 sandbox 會自動在其他節點無損恢復。

來源：[官方 roadmap](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/roadmap.md)

### 6.2 基礎設施要求

手動多機部署文件要求：

- x86_64 或 aarch64
- 啟用 KVM
- Docker
- compute node 可連線至 CubeMaster，預設 TCP 8089
- `CUBE_SANDBOX_NODE_IP` 必須是可路由 IP
- 各節點使用一致且不與宿主網路衝突的 sandbox CIDR
- 一般部署文件明確標示不支援 nested virtualization

來源：[多機部署前置條件與故障排查](https://github.com/TencentCloud/CubeSandbox/blob/70d46f16f8423ec6fb8ee6c859097de75782ef14/docs/zh/guide/multi-node-deploy.md#前置條件)

### 6.3 規模上限尚未明確

官方 repo 沒有提供正式的最大 compute-node 數、最大跨節點 sandbox 數或多節點故障注入 benchmark。因此可以確認機制存在，但不能僅依靜態原始碼判定 production scale ceiling。

## 7. 導入判斷

| 評估項目                    | 判斷                                           |
| --------------------------- | ---------------------------------------------- |
| 多 worker／compute node     | **支援**                                       |
| 官方部署流程                | **支援**，手動及 Tencent Cloud Terraform       |
| 節點自動註冊與心跳          | **支援**                                       |
| 新 sandbox 跨節點調度       | **支援**                                       |
| 資源感知負載分散            | **支援，但需正確配置 scorer／top-N**           |
| 多 CubeMaster endpoint      | **支援簡單 round-robin 與 transport failover** |
| 預設部署即為完整 HA         | **否**                                         |
| 既有 sandbox 線上重新平衡   | **不支援，仍在 roadmap**                       |
| Worker 故障後跨節點無損恢復 | **不支援，仍在 roadmap**                       |
| 已知正式叢集規模上限        | **官方未說明**                                 |

## 建議

若要以 CubeSandbox 建立多 worker 服務，建議至少：

1. 使用相同 release bundle 部署所有 compute node。
2. 啟用 scheduler scorer，並將 `priority_select_num` 設為大於 1。
3. 監控 node heartbeat、Ready 狀態、CPU／memory quota、MicroVM 數及磁碟使用率。
4. 將單一 worker 故障視為該節點上既有 sandbox 可能失效，而非假設自動遷移。
5. 生產環境另行設計 CubeMaster、CubeAPI、Redis、MySQL、共享儲存及入口的 HA。
6. 上線前執行實際的節點斷線、CubeMaster 切換、Redis／MySQL 故障及容量壓力測試。
