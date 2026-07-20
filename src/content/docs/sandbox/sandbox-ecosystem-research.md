---
title: Agent sandbox 生態系調查:15 個開源專案的設計概念
description: 對 15 個 agent sandbox 相關開源專案的原始碼調查,萃取 workspace transport、worker protocol、fleet、vault、in-guest tooling 的可借設計概念。
---

產生日期:2026-07-15

開源專案做 shallow-clone + 原始碼閱讀(非只讀 README),目的是**萃取設計概念**,不預設採用任何
專案。四個平行軌道:microVM runtimes、fleet orchestration、agent control planes、sandbox SDK/服務層。
每條結論附 repo 檔案路徑或文件出處;各專案均記錄檢視當日的 commit。

調查對象:CubeSandbox、microsandbox、arrakis、boxlite;e2b-dev/infra、daytona v0.190.0、
kubernetes-sigs/agent-sandbox、rivet agentos;rivet sandbox-agent、vercel/eve、
litellm-agent-control-plane;agent-infra/sandbox(AIO)、cloudflare/sandbox-sdk、google/sandboxed-api;
OpenSandbox(補查,含對一份外部推薦報告的 fact-check)。

## 交叉觀察(最重要的訊號)

1. **跨 WAN 的可變 workspace 傳輸:15 個專案裡零解。** CubeSandbox 的 roadmap 明列 Cross-Node
   Pause/Resume「尚未實作」;microsandbox 的 cross-machine sync 依然未出貨(唯一多機是半成品的
   中心化 SaaS 代管);arrakis 純單機且停滯 13 個月;e2b 的共用快取層明確定位為「LAN 加速層,
   非 WAN 傳輸手段」(另備 P2P 直傳);其餘專案全部假設 sandbox 與控制邏輯同機或直連可達。
   **這是 issue #88 自建 git-as-CAS 方向的第三次獨立印證——這個問題業界沒有現成答案可抄。**
2. **「持久化真相不放計算節點本地」是跨節點恢復的業界共識。** e2b(object storage 為權威 +
   content-addressed diff 鏈)、Daytona(OCI registry)、Gitpod(object storage)、agentOS(交給
   平台資料庫)——四者都選「跨節點恢復不需回原節點」,前提一致。與 mikan 的 host-side
   generation store 方向完全吻合。
3. **mikan 的 lease-watermark fencing 是相對優勢,不是落後項。** 沒有任何被調查專案有同等級的
   fencing:e2b 靠 Nomad 健康檢測、Daytona 靠 Postgres 狀態機 + Cron、agentOS 假設平台保證單一
   writer、Cloudflare 靠 Durable Object 平台白送「identity → 全球唯一實例」。唯一接近的是
   CubeSandbox 的 TTL 鎖(鎖過期不視為成功),仍偏陽春。
4. **「secret 永不進 guest、在網路邊界做替換」是四方獨立收斂的成熟模式。**
   microsandbox(placeholder + DNS pin + SNI + authority 三重綁定防 TOCTOU/domain fronting)、
   boxlite(per-box MITM CA,私鑰只在 host)、CubeSandbox(CubeEgress L7 代理 header injection +
   log 自動 scrub + deny+inject 視為設定錯誤)、OpenSandbox(Credential Vault:egress sidecar
   placeholder 同構——佐證 mikan vault 的 HTTP credential 走 placeholder、file credential 走
   content 投影的既有分工正確。其中 OpenSandbox 的 `docs/guides/credential-vault.md` 是這個模式
   **規格最完整的一份文件**(binding schema、五種 auth type、scoped substitutions 的逐 surface
   邊界規則、redaction set 涵蓋所有編碼形態),可直接當 mikan 的規格參考書。注意其 sidecar 與
5. **exec 協定「不可統一」是業界反覆出現的結論。** Cloudflare 的 `SESSION_EXECUTION.md` 給出
   完整理論:前景(狀態持續、暫存檔同步寫入)與背景(FIFO 串流、可 kill)「統一必犧牲其一」;
   AIO Sandbox 同樣分 bash(offset 輪詢)/shell(WebSocket+PTY)雙軌。
6. **dial-home 方向再獲印證。** Daytona 從 v0(控制面主動 RPC-in)演化到 v2(runner 主動
   long-poll + 獨立心跳);boxlite runner 也是 pull-based 派工。但兩者認證都比 mikan 弱
   (靜態 bearer token、無 join token、無 mTLS)——這塊不該學。

## 按 mikan 問題域整理的可借概念

### Workspace generation / transport(issue #88 直接輸入)

| 概念                                                                                  | 出處                                                                                                                | 說明                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Quiesce → 複製/快照 → resume 的三段式一致性窗口                                       | arrakis `pkg/server/server.go:1470-1496`;boxlite `clone_export.rs:33-70`(quiesce 內做最小操作、quiesce 外批次 fork) | snapshot commit 前確保 guest flush 的順序保證;microsandbox 踩過反例的坑(host 在 guest sync 完成前拆 VM 丟失寫入,changelog 2026-05-22) |
| 「底層原語涵蓋的狀態」vs「應用層需手動同步的狀態」顯式劃界                            | arrakis `server.go:1498` 註解                                                                                       | git commit 涵蓋 workspace 檔案、不涵蓋執行中行程/連線,對後者要有顯式宣告                                                              |
| 恢復前先驗證備份產物真實存在                                                          | Daytona `sandbox-start.action.ts` `inspectSnapshotInRegistry`                                                       | mikan failover 從 generation 重建前,先驗 host bare repo 中該 ref/objects 完整(`git fsck`/`cat-file`),避免復原到沒資料的地方           |
| Content-addressed artifact 分發 + per-node 進度追蹤(`N/M ready`)                      | CubeSandbox `CubeMaster/pkg/templatecenter/distribution.go`                                                         | 「某 generation 是否已在某 worker materialize」的追蹤欄位設計                                                                         |
| Snapshot 依賴鏈摘要供排程親和性(`SchedulingMetadata`)                                 | e2b `pkg/scheduling/metadata.go`                                                                                    | generation 攜帶內容依賴摘要,placement 可估 worker 本地快取命中,免逐一詢問                                                             |
| `checkChanges(path, {since: version})` 三態斷線續傳(unchanged / changed / 需全量重來) | cloudflare `packages/sandbox/src/sandbox.ts:4991-5015`                                                              | WAN 重連後「能算 delta 還是整包重來」的介面形狀,直接對應 generation 增量判斷                                                          |
| 快照粒度分級(完整 vs filesystem-only,犧牲秒級續跑換體積)                              | e2b `sandbox.go:1247`                                                                                               | per-turn snapshot 策略可依情境選粒度,不必每次最貴                                                                                     |
| Snapshot descriptor 的 `extensions`(可忽略)/`requires`(必須認得)分離                  | microsandbox `snapshot.json` schema                                                                                 | generation 格式演進不造成 silent 損毀的 schema 慣例                                                                                   |
| 「worker 本地磁碟只是快取、可整坨刪除」不變量                                         | e2b `template/cache.go:88-92`                                                                                       | 呼應 workspace dir redesign 的 Y 方向:權威在 generation store,本地可拋棄                                                              |
| 唯讀 base + 可寫 delta 層物理分離                                                     | arrakis(rootfs/vda + stateful/vdb + overlayfs)、CubeSandbox cubecow、e2b OverlayFS                                  | 印證 issue #88 的 overlayfs materialization 規劃                                                                                      |
| Reflink O(1) 扁平快照(無 COW 鏈、崩潰重掃描恢復)                                      | CubeSandbox `cubecow/`(XFS FICLONE)                                                                                 | 與 issue #88 的 clonefile/reflink 路線相同,「扁平無鏈式依賴」的可靠性取向值得吸收                                                     |
| 原生 qcow2 flatten / header-only rebase                                               | boxlite `disk/qcow2.rs:176-1064`                                                                                    | 若未來走 block-level snapshot 的參考;成本高,非近期                                                                                    |

### Worker protocol / fleet 生產強化

| 概念                                                                                                        | 出處                                         | 說明                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Protocol generation 協商:host 呼叫過新功能時**本機提前失敗**                                                | microsandbox `crates/protocol/VERSIONING.md` | guest 內 agentd 版本凍結、host 持續升級的情境與 mikan host/長壽命 worker 完全同構       |
| `spec`(intent)vs `status` condition(observed,含 reason/observedGeneration)分離;condition 陣列取代單一 phase | k8s agent-sandbox `sandbox_types.go`         | worker/runtime 狀態表達的命名慣例                                                       |
| `operatingMode: Running \| Suspended` 與 KEP-694 的六個被拒方案論證                                         | k8s agent-sandbox KEP-694                    | 任何「暫停但保留身份」欄位設計的現成 checklist(boolean 不利擴充、replicas=0 語意衝突等) |
| Requeue-at-expiry(算準喚醒時點)取代固定輪詢                                                                 | k8s agent-sandbox `checkSandboxExpiry`       | lease 到期監控效率                                                                      |
| Draining 連續 N 次確認無殘留才 decommission                                                                 | Daytona `handleCheckDecommissionRunners`     | 防瞬斷誤判;值得核對 mikan 現有 draining 是否已有                                        |
| Top-K + 隨機化 placement(非純貪婪)、TOPSIS 多準則容量評分                                                   | Daytona、e2b `BestOfK`                       | 未來多 worker 打分時的現成演算法;防新 session 擠向同一台                                |
| Ownership 三態 + `adoptable` label 防禦性領養                                                               | k8s agent-sandbox `checkOwnership`           | 孤兒 workspace/credential 資源的防誤領設計                                              |
| Warm pool =「哨兵 owner + 事後過戶」                                                                        | Daytona warm pool、k8s SandboxWarmPool       | 若做 pre-warm microVM 池,比自建 pool manager 簡單                                       |
| 生命週期轉換即廣播事件(`vmBooted`/`vmShutdown`)                                                             | agentos `vm.rs`                              | worker telemetry 可訂閱 wake/sleep 週期                                                 |
| 協定私有擴充統一命名空間前綴(`_sandboxagent/...`)                                                           | rivet sandbox-agent `research/acp/spec.md`   | 若在標準協定上加 mikan 擴充的命名慣例                                                   |
| 具名鎖包裝型別(非裸字串 key)                                                                                | litellm-acp `locks.rs` 呼叫點                | 可讀性小模式                                                                            |

### Vault / egress

| 概念                                                                                                                             | 出處                                                            | 說明                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Egress 層 credential injection:secret 永不進 sandbox、log 自動 scrub、deny+inject 視為設定錯誤                                   | CubeSandbox `CubeEgress/lua/*` + `docs/guide/security-proxy.md` | 最完整的 egress-substitution 實作範本                                                                 |
| Per-sandbox 短效 CA、私鑰只在 host、Debug trait 手動 redact                                                                      | boxlite `net/ca.rs`                                             | MITM 路線的安全衛生清單                                                                               |
| First-match-wins 宣告式 L7 egress 規則 schema(match/action/inject)                                                               | CubeSandbox                                                     | 網路政策 schema 形狀                                                                                  |
| Binding schema:match(scheme/host/method/path)× 五種 auth type × scoped substitutions(path/query/header/body 逐 surface 邊界規則) | OpenSandbox `docs/guides/credential-vault.md`                   | vault routing 規則升級的規格參考;「假 env var 起動 CLI、出站邊界注入真值」直接解 private npm/PyPI/git |
| Redaction set 涵蓋 raw/URL-encoded/form-encoded/JSON-escaped 全部編碼形態                                                        | OpenSandbox credential-vault                                    | mikan log 遮蔽只遮 raw 值會漏                                                                         |
| Refuse-to-activate:強制層不夠強(DNS-only 可被 direct-IP 繞過)就拒絕啟用而非降級;default-allow 發警告並排入淘汰                   | OpenSandbox credential-vault + egress                           | vault injection 前提不成立時 fail-closed                                                              |
| 替換一次掃描原文、注入值不再被掃;path 改寫後含 traversal 內容直接拒發                                                            | OpenSandbox credential-vault                                    | placeholder substitution 的正確性細節                                                                 |

### In-guest tooling / exec 協定

| 概念                                                                         | 出處                                                 | 說明                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| 前景/背景 exec 雙軌不可統一的完整論證                                        | cloudflare `docs/SESSION_EXECUTION.md:15-70,153-160` | mikan bash exec 若要加互動/串流,分兩條路徑而非疊加 |
| Offset-based 輪詢 exec(`offset`/`stderr_offset` 續傳、可 kill、hard_timeout) | AIO Sandbox `bash.exec`/`bash.output`                | WAN 不穩連線下比長連線串流更耐斷,重連只需帶 offset |
| 3-byte binary prefix 分離 stdout/stderr 保序                                 | cloudflare `SESSION_EXECUTION.md:71-82`              | 已驗證的簡單方案                                   |
| `fs.watch` + 50ms 輪詢 hybrid 完成偵測                                       | cloudflare `SESSION_EXECUTION.md:88-98`              | fs.watch 在 tmpfs/overlayfs 漏 rename 事件的已知坑 |
| FIFO 阻塞讀取做 PID 同步(而非輪詢半寫檔案)                                   | cloudflare `SESSION_EXECUTION.md:133-140`            | 檔案系統 IPC 的競態消除                            |
| tar 批次上傳解壓 API                                                         | rivet sandbox-agent `/v1/fs/upload-batch`            | skills/vault 靜態內容單向佈署,一個請求勝過逐檔傳輸 |
| 執行期動態註冊 shutdown hook                                                 | AIO Sandbox `POST /v1/sandbox/hooks`                 | worker draining 時讓 in-guest 邏輯收尾             |
| 內建 observability(cgroup/process/disk snapshot 匯出)                        | AIO Sandbox `sandbox.observe*`                       | agent 自助 debug/profiling as a service            |
| Universal event schema + best-effort converter,轉不掉的存 `Unparsed` 不丟    | rivet sandbox-agent `universal-agent-schema`         | 未來 in-guest 支援多種 agent CLI 的正規化範式      |
| Transport 可抽換(http/ws/rpc)而 API 契約不變                                 | cloudflare `sandbox.ts:1592-1621`                    | worker 通訊協定與介面解耦                          |

### 對話/執行狀態模型(control plane 層)

| 概念                                                                 | 出處                                                         | 說明                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| session→turn→step 三層 + 「已完成 step 永不重跑、只重播結果」不變量  | vercel/eve `docs/concepts/execution-model-and-durability.md` | WAN 不穩場景的重播語意設計詞彙                                                              |
| continuationToken(恢復權)vs sessionId/runId(觀察權)分離              | vercel/eve                                                   | adapter 的權限模型                                                                          |
| Stage → 原子切換 → 引用歸零才 GC                                     | vercel/eve `development-generation.ts`                       | mikan extension/skill 熱重載可借(注意:eve 的 "generation" 與 workspace generation 同名異義) |
| Approval 安全不變量:「approval 是關卡不是授權;政策查詢失敗必須拒絕」 | vercel/eve `docs/patterns/multi-tenant-approvals.md`         | 工具審批流程 checklist                                                                      |
| Runtime 正規化 adapter trait(統一事件詞彙)                           | litellm-acp `runtime_resolution.rs`                          | 同一介面後接不同 agent 後端                                                                 |
| 設定檔遷移錯誤可行動化(偵測 schema 變化給具體升級指引)               | litellm-acp `src/proxy/config.rs`                            | host-authoritative settings 演進的錯誤訊息                                                  |

## 各 repo 一行判定

| Repo                        | 定位/隔離                                              | 成熟度(2026-07)                                    | 對 mikan 的判定                                                                                         |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| CubeSandbox                 | Tencent;Cloud Hypervisor + Kata-agent 衍生             | 活躍但年輕(2026-04 開源),Apache-2.0,Linux/KVM only | 概念礦最豐(cubecow/CubeEgress/分發追蹤);節點註冊明文無認證是反面教材                                    |
| microsandbox                | YC;libkrun,三平台(KVM/HVF/WHP)                         | pre-1.0,日更,Apache-2.0                            | cross-machine sync 仍未出貨——migration research 的觀察維持有效;protocol 協商與 snapshot schema 慣例可借 |
| arrakis                     | 個人;Cloud Hypervisor                                  | **停滯 13+ 個月**,AGPLv3                           | 只借概念(quiesce 三段式、狀態劃界),不借代碼                                                             |
| boxlite                     | "SQLite for sandboxing";libkrun + jailer               | 0.9.7 活躍,核心 Apache-2.0 / apps AGPL             | 原生 qcow2 操作與 MITM CA 可借;fleet 層弱一致(local-state-wins)                                         |
| daytona v0.190.0            | **Docker 容器,非 microVM**;Postgres+Redis+OCI registry | 生產級,AGPLv3                                      | archive=commit+push registry、恢復前驗證、TOPSIS/draining 可借;認證比 mikan 弱                          |
| k8s agent-sandbox           | isolation-agnostic CRD(RuntimeClass)                   | v1beta1,SIG Apps,Apache-2.0                        | lifecycle API 設計(KEP-694)是最值得借的「命名決策文件」;placement 無可借(交給 kube-scheduler)           |
| rivet agentos               | V8 isolate/WASM in-process VM                          | 活躍,Apache-2.0                                    | 排程/fencing 不在此 repo;fs-in-SQL-BLOB 對 git workspace 是倒退;只借「狀態結構化」原則                  |
| rivet sandbox-agent         | in-sandbox Rust daemon(9 種 provider)                  | 0.5.0-rc,活躍,Apache-2.0                           | provider-agnostic in-guest daemon 的典範;持久化哲學與 mikan 相反                                        |
| vercel/eve                  | filesystem-first durable agent framework               | beta,日更,Apache-2.0                               | 狀態模型詞彙可借;單 agent 單部署與 mikan 多租戶方向不合                                                 |
| litellm-agent-control-plane | LiteLLM gateway 上的 agent 功能層                      | 活躍,MIT                                           | 「control plane」=API/計費層,無機群調度;locks.rs 是單行程 mutex,不可對映 lease fencing                  |
| agent-infra/sandbox(AIO)    | Docker(seccomp=unconfined),server 閉源                 | 1.11.0,活躍,Apache-2.0(SDK)                        | API surface 目錄價值高(watch/hook/observability);隔離模型不可借                                         |
| cloudflare/sandbox-sdk      | Cloudflare Containers + Durable Objects                | Beta,日更,Apache-2.0                               | 本組唯一 server 端可讀原始碼;SESSION_EXECUTION 文件是 exec 協定設計的必讀材料                           |
| google/sandboxed-api        | C/C++ 函式庫 syscall 沙箱(Sandbox2)                    | 成熟,Apache-2.0                                    | 層級不匹配,參考價值最低(誠實記錄)                                                                       |

## 建議的後續行動(對映既有 roadmap)

1. **Issue #88 G0/G1 的設計輸入**:snapshot 前 quiesce/flush 順序(arrakis/boxlite 三段式);
   generation 恢復前驗證(Daytona `inspectSnapshotInRegistry` → mikan 用 `git fsck`/ref 驗證);
   materialize 進度追蹤欄位(CubeSandbox `N/M ready`);generation schema 用 `extensions`/`requires`
   慣例(microsandbox);斷線重連的三態判斷介面(cloudflare `checkChanges`)。
2. **Worker protocol 強化 batch**:protocol generation 協商(microsandbox 模式);狀態欄位改
   spec/status condition 慣例 + KEP-694 checklist;draining 連續確認;requeue-at-expiry。
   placeholder 路徑是否已涵蓋同等防護;CubeEgress 的「deny+inject = 設定錯誤」fail-safe 規則
   直接可抄進 mikan 的 vault routing 驗證。**規格參考書用 OpenSandbox 的 credential-vault.md**:
   binding schema(match + auth type + scoped substitutions)+ redaction 全編碼形態 +
   refuse-to-activate 紀律;private npm/PyPI/git 用「guest 放假 token、出站邊界對 registry host
   注入真值」的配方,比 env var 注入高一個安全等級。
3. **Exec 協定演進原則**:未來要互動 PTY 或即時串流時走獨立雙軌,不疊加在現有 exec 上
   (cloudflare 論證);WAN 韌性場景評估 offset 輪詢形狀(AIO)。
4. **不追**:VM memory snapshot 跨機(業界皆未解,mac↔linux 架構不可攜);fs-in-SQL(agentOS
   模式對 git workspace 倒退);K8s/Nomad 級外部依賴(與自建方向矛盾)。

## 方法與出處

四個 Sonnet 5 背景 agent 平行執行,各自 shallow-clone 指定 repo(記錄檢視 commit)、閱讀
README/docs/架構文件與關鍵原始碼,結論標 observed(檔案路徑)vs inference。完整軌道報告
(track-g/h/i/j)含逐 repo 模板分析與完整引註,本文為按問題域重組的合併版;所有 repo 均為
公開 GitHub 專案,引註之檔案路徑可直接對照原始碼驗證。
