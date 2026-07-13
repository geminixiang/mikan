---
title: MicroVM sandbox 遷移研究
description: 將 mikan 受管 image sandbox 遷移至可由單機擴展到多機的 Gondolin/QEMU 架構之可行性研究。
---

產生日期：2026-07-13

## 可行性結論

**有條件可行。** mikan 可以建立在可靠基礎上，實作可由單機擴展至多機的
microVM sandbox 架構；前提是產品定位為專精的 agent sandbox，而不是任意 Docker
image 的直接替代品。

可靠的底層元件已經存在：

- QEMU 提供 VM 邊界，並在 Linux 透過 KVM、macOS 透過 HVF 使用硬體加速。QEMU
  將硬體加速虛擬化視為具有安全支援的隔離用途；TCG 不應作為 production
  workload 的安全或效能備援。([QEMU 加速器](https://www.qemu.org/docs/master/system/introduction.html)、
  [QEMU 安全模型](https://www.qemu.org/docs/master/system/security.html))
- Gondolin 已提供 mikan 若直接使用 QEMU 就必須自行建造的本機 agent sandbox
  控制層：VM lifecycle、command execution、VFS、受控網路、secret placeholder
  與磁碟 checkpoint。([Gondolin 架構](https://earendil-works.github.io/gondolin/architecture/)、
  [VM API](https://earendil-works.github.io/gondolin/sdk-vm/))
- Git、共享 POSIX storage 與外部 Vault 都是成熟的 workspace 與 secret 傳遞元件，
  但它們本身不提供 mikan 所需的排程語意。

缺少的分散式層規模不小，但邊界清楚。mikan 必須自行實作 worker daemon、worker
驗證、持久 lease、placement、reconciliation、workspace prepare/finalize、限縮範圍的
secret 傳遞、資源限制與維運 telemetry。Gondolin 是 local-first 專案，不包含這些
fleet 功能。

因此，Gondolin 必須放在 mikan 自有的 worker/runtime interface 後方。Gondolin API、
本機 session registry 與 QEMU process identity 都不應成為 mikan 的持久公開契約。

## 目前的 mikan 契約

需要保留的不是 `image:*` parser，而是分散在 `src/execution-resolver.ts`、
`src/provisioner.ts`、`src/sandbox/container.ts`、`src/vault/index.ts` 與 sandbox
command/tool 中的受管行為。

目前 `image:*` 提供：

- 每個 conversation vault key 對應一個受管 runtime
- create、start、stop、recreate、reconcile 與 idle stop lifecycle
- 掛載於 `/workspace` 的 private/full workspace mode
- command execution 時注入 vault environment
- 可寫入的 vault file credential projection
- 每個 runtime 的網路隔離
- CPU/memory 預設值、暫時 override 與 boost control
- mount 或 network configuration 漂移時偵測並重建

遷移後可以保留使用者可見的 lifecycle 與 `/workspace` 概念。但無法在不改變語意或
投入大量額外工程的情況下，同時保留任意 OCI image、無限制的 Docker 式網路、可寫入
的 secret mount 與動態 resource resize。

## 基礎元件評估

| 元件                     | 評估                                  | 可可靠依賴的部分                                                               | mikan 的責任                                                           |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| QEMU + KVM/HVF           | 成熟基礎                              | VM process、硬體邊界、virtio device、Linux/macOS 加速                          | 固定支援的 QEMU 版本；不可信 production workload 禁用 TCG              |
| Gondolin QEMU backend    | 有潛力但仍早期的整合基礎              | 本機 VM create/exec/close、VFS、網路控制、secret placeholder、qcow2 checkpoint | 版本固定、相容性測試、lifecycle reconciliation、fleet control          |
| Gondolin VFS             | 實用，但成熟度低於 QEMU               | 明確 host path、memory/real/read-only/shadow provider                          | Workspace policy、並行控制、遠端 materialization、效能測試             |
| Gondolin secret          | 適合 HTTP header credential           | 真實 secret 留在可信 host process，只對允許的 destination 代換                 | 傳遞限縮範圍的值、定義 allowed host、處理 non-HTTP/file credential     |
| Gondolin checkpoint      | 實用的最佳化，不是持久 runtime 遷移   | 僅磁碟的 qcow2 checkpoint，配合同一 guest asset 恢復                           | 儲存/傳輸 checkpoint 與 asset build identity；故障後重啟 process       |
| Linux cgroup v2          | 成熟的 Linux resource control         | 限制 worker/QEMU process 的 CPU、memory 與 I/O                                 | 建立 per-sandbox cgroup，收集使用量與終止原因                          |
| Git/worktree             | 成熟的 source workspace 基礎          | Worker-local repository cache 與隔離 worktree                                  | 保留未提交與非 Git 資料，安全發布結果                                  |
| NFS/shared POSIX storage | 成熟部署選項，但 cache coherence 有限 | 避免啟動時大量傳輸 workspace，維持穩定 logical path                            | 強制 single writer、fencing、lock discipline 與 worker 故障復原        |
| Vault response wrapping  | 成熟的選用 secret handoff primitive   | 傳遞短效、單次使用 token，而非直接傳送 secret                                  | Policy、worker identity、unwrap validation、renewal、revocation、audit |

以上評估的重要限制：

- Gondolin 官方稱其為 early project。目前發布版本為 `0.12.0`，package 要求 Node
  `>=23.6.0`，但 mikan 目前支援 Node `>=22.19.0`。讓獨立 worker process 使用 Node 24，
  可以避免立刻提高 mikan host 的 runtime 下限。([Gondolin 文件](https://earendil-works.github.io/gondolin/)、
  [package.json](https://github.com/earendil-works/gondolin/blob/main/host/package.json)、
  [releases](https://github.com/earendil-works/gondolin/releases))
- Gondolin 表示 ARM64 是測試最多的 runtime 路徑。CI 會建置兩種 guest architecture，
  但這不代表所有 Linux/macOS 與 QEMU 組合都有長期 production 經驗。
  ([Gondolin README](https://github.com/earendil-works/gondolin)、
  [Gondolin CI](https://github.com/earendil-works/gondolin/blob/main/.github/workflows/ci.yml))
- Gondolin VFS vendored 並修改了 Node VFS 的 snapshot。這是實用的實作，但在視為 bind
  mount 等價之前，mikan 必須測試 symlink、permission、rename、watcher、package
  manager 與大型 directory tree。([VFS 實作說明](https://earendil-works.github.io/gondolin/vfs/))
- Gondolin 明確表示尚無完整的 DoS resource governance。Linux cgroup v2 可以在
  Gondolin 外部提供 CPU、memory 與 I/O 強制限制；現有 Gondolin 文件沒有提供 macOS
  上的等價跨平台基礎。([Gondolin 安全設計](https://earendil-works.github.io/gondolin/security/)、
  [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html))
- NFSv4.1 不提供通用的 distributed cache coherence。Concurrent writer 必須透過 lock
  或 share reservation 協調，因此多個 worker 共享 workspace 時，mikan lease 不能只是
  可有可無的 metadata。([RFC 8881 第 10 節](https://www.rfc-editor.org/rfc/rfc8881.html#section-10))

## `image:*` 功能對照

| 現有行為                            | Gondolin/QEMU 能力                                                          | 結論                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Per-conversation managed runtime    | 穩定的 VM session UUID 與 create/exec/close API                             | 可行；conversation mapping 與 reconciliation 由 mikan 負責 |
| Command execution 與 streaming      | Buffered/streamed output、PTY、cancellation、bounded backpressure           | 可行                                                       |
| 本機 private/full workspace         | `RealFSProvider`、`ReadonlyProvider`、`ShadowProvider`、mount routing       | 可行，但需要語意與效能測試                                 |
| 遠端 workspace                      | 不提供 fleet workspace transport                                            | 不可直接支援；由 mikan 實作                                |
| HTTP API secret                     | 使用 guest placeholder，依 destination 由 host substitution                 | 可行，且比 guest env injection 更安全                      |
| File 與 non-HTTP credential         | 明確 VFS projection 或 mapped TCP/SSH exception                             | 部分可行；值會進入 guest，必須採 opt-in policy             |
| VM 建立時設定 CPU/memory            | `sandbox.cpus` 與 `sandbox.memory`                                          | 可行                                                       |
| 動態 boost/temporary limit          | 無文件化的 Gondolin runtime resize 契約；無完整 DoS governance              | 無直接對等功能；需重建 VM 或從外部限制                     |
| Idle stop                           | 快速、可拋棄的 VM lifecycle                                                 | 可行；timer 與 policy 由 mikan 負責                        |
| Docker bridge/通用 outbound network | 受控 HTTP/TLS、明確 SSH 與 mapped TCP，無 generic NAT                       | 刻意不相容                                                 |
| 任意 Docker/OCI image               | Alpine image builder；選用 OCI rootfs source 不代表任意 container execution | 不支援                                                     |
| Live migration/failover             | 僅磁碟 checkpoint；無 RAM/process snapshot                                  | 不支援；failover 代表重新 provision 與 restart             |
| 多機排程                            | 只有 local session 與 Unix socket                                           | 不支援；由 mikan 實作                                      |

Gondolin 已知限制還包含預設網路模式不支援 HTTP/2、HTTP/3、QUIC、WebRTC、generic
UDP，以及 image builder 僅支援 Alpine。這些是產品限制，不是小型 migration bug。
([Gondolin 限制](https://earendil-works.github.io/gondolin/limitations/)、
[custom image](https://earendil-works.github.io/gondolin/custom-images/))

## 建議架構

單機與多機部署應使用同一條控制路徑：

```text
mikan host
  -> SandboxScheduler
  -> WorkerClient
  -> local Unix socket 或 remote mTLS
  -> mikan-worker
  -> Gondolin
  -> QEMU/KVM 或 QEMU/HVF
```

單機部署在同一台機器執行 `mikan host` 與 `mikan-worker`。多機部署只替換 worker
discovery 與 workspace provider，不改變 sandbox execution contract。將 worker 保持為
獨立 process，也可以隔離 Gondolin 的 Node 版本與 QEMU process management。

### Control plane 責任

mikan host 保持以下資料的唯一權威：

- conversation/session routing
- vault policy 與 secret authorization
- worker registry 與 health
- sandbox profile 與 image build ID
- lease allocation 與 fencing epoch
- run queue 與 idempotency record
- workspace generation 與 finalization state

目標 topology 是一個權威 mikan host 搭配多個 worker。因為 host 是唯一 scheduler，
這個階段不需要 distributed consensus。Host high availability 是另一個專案，屆時才需要
shared durable store 與 leader election。

### Worker 責任

每個 worker 只負責本機 execution：

- 驗證自身 identity 與 signed/scoped lease
- 準備 worker-local workspace path
- 啟動並監督 Gondolin/QEMU
- 執行 command 並傳送 output stream
- 套用 network 與 VFS policy
- 在 memory 中保存 lease-scoped secret value
- 強制執行本機 resource limit
- 回報 health、capacity、usage 與 exit reason
- finalize workspace result 並移除 ephemeral state

Gondolin session registry 是 cache directory 下的本機 metadata，只適用 local
attach/list workflow，不能作為 fleet source of truth。
([Gondolin VM session](https://earendil-works.github.io/gondolin/sdk-vm/))

### 最小 worker protocol

Protocol 應保持專精：

- `lease`：保留 sandbox profile 與 workspace generation
- `exec`：使用 request ID，在 lease 下執行 command
- `status`：回報 sandbox 與 workspace state
- `stop`：停止 VM，只保留 workspace provider 宣告為 durable 的資料
- `release`：finalize 或丟棄 workspace state，並撤銷 secret
- `health`：回報 capacity、OS、architecture、accelerator、profile 與 cached guest
  asset build ID

每個 mutating request 都需要 idempotency key；每個 lease 都需要單調遞增的 fencing
epoch。Worker 必須拒絕過期 epoch，避免網路分割後的舊 worker 在 host 已重新指派
conversation 後繼續寫入。實際執行保證只能是 at-least-once；跨 worker 或網路故障時，
mikan 無法保證 shell side effect exactly-once。

### 排程與 lifecycle

Conversation 活躍期間使用 sticky placement：

1. 選擇符合 OS/architecture/profile 且仍有 capacity 的健康 worker。
2. 建立 durable lease，包含 worker ID、sandbox ID、workspace generation、profile/image
   build ID、fencing epoch 與 expiry。
3. VM 活躍期間透過 worker heartbeat renew lease。
4. Idle timeout 後停止 VM，只保留 workspace provider 宣告為 durable 的 state。
5. Worker 遺失時，讓 lease 過期、增加 fencing epoch、在其他位置準備最新 committed
   workspace generation，並建立新 VM。

Disk checkpoint 只能是 cold-start cache，不能作為 lease authority。Gondolin checkpoint
會停止來源 VM、不包含 tmpfs 與 VFS-mounted workspace，恢復時也需要相同 build ID 的
guest asset。([Gondolin snapshot](https://earendil-works.github.io/gondolin/snapshots/)、
[lifecycle guidance](https://earendil-works.github.io/gondolin/workloads/))

## Workspace 架構選項

Worker 最終都需要一個 local directory，交給 Gondolin `RealFSProvider`。概念上的
`WorkspaceProvider` boundary 應負責在 worker 上 prepare generation、提供 local path，
最後 finalize 或 abort generation。這是不同部署規模間的主要替換點。

### 選項 A：local path

Host 與 worker 位於同一台機器時，直接使用現有 host workspace。這有最低啟動成本，
也能保留目前行為。它是第一階段方案，不是 remote worker 方案。

### 選項 B：shared filesystem

每個 worker mount 相同的 NFS 或 managed POSIX filesystem。這可以避免啟動時複製
workspace，也是最簡單的初期遠端部署。Guest 仍只看得到 Gondolin VFS 明確暴露的
directory 與 policy。

必要限制：

- 每個 conversation workspace 同時只能有一個 active writable lease
- Worker partition 或 crash 後重新指派前必須 fencing
- 不假設 worker 間存在通用 cache coherence
- Completed turn 使用明確的 atomic marker/generation
- 必須 benchmark package install 與大型 source tree，因為每個 guest VFS operation
  先到 worker 上的 Gondolin，再可能存取 network storage

這是建議的第一版多機 workspace model，因為單機轉多機的維運差異最小；它不是最終的
高擴展性方案。

### 選項 C：worker-local Git cache 與 worktree

每個 worker 維護 bare/object cache，並為每個 lease 建立 worktree。Git worktree 共用
repository object，但各自保有 `HEAD` 與 index；partial clone 可以減少首次傳輸，並在
需要時取得缺少的 object。([Git worktree](https://git-scm.com/docs/git-worktree.html)、
[partial clone](https://git-scm.com/docs/partial-clone))

這能提供快速 local I/O，對 source-heavy workload 也比 shared storage 更容易擴展。
但它無法單獨保留任意 workspace 語意：untracked file、ignored build output、local-only
repository、conversation artifact 與未提交的 host change，都需要另一條 snapshot/artifact
channel。產品必須先定義何種 workspace state 才是權威資料。

### 選項 D：content-addressed workspace generation

建立包含 path、metadata 與 content digest 的 manifest；上傳缺少的 blob；在選定 worker
上 materialize generation；執行後 atomically publish 新 generation。這支援 non-Git
workspace 與 incremental transfer，但 mikan 必須自行處理 integrity verification、GC、
conflict policy、symlink/permission semantics、upload 中斷恢復與 artifact size limit。

這是後續最佳化，不是第一版 multi-worker 的前置需求。

### 不建議作為預設：將 remote VFS proxy 回 host

Gondolin 允許 custom JavaScript VFS provider，因此 worker 理論上可以將每個 filesystem
operation proxy 回 mikan host。但 Gondolin 的 guest-to-provider 路徑已使用 FUSE/RPC，
且限制單次 RPC payload；若再為每個 filesystem operation 加上 host-to-worker network
latency，會形成脆弱且過度頻繁通訊的 distributed filesystem。
([Gondolin VFS](https://earendil-works.github.io/gondolin/vfs/)、
[安全設計](https://earendil-works.github.io/gondolin/security/))

## Vault 與 secret 傳遞

Remote worker 屬於 trusted computing base。Gondolin 的保證是：真實 HTTP secret 留在
trusted host process，不進入 guest；在 fleet 架構下，這個 trusted process 位於 worker。
([Gondolin secret](https://earendil-works.github.io/gondolin/secrets/)、
[安全模型](https://earendil-works.github.io/gondolin/security/))

建議流程：

1. mikan host 為 lease 授權 secret name 與 destination host。
2. 透過 authenticated transport，向 worker 傳送短效、單次使用且加密/wrapped 的
   bundle；絕不傳送完整 conversation vault。
3. Worker 在 unwrap 前驗證 lease ID、fencing epoch、expiry 與預期 secret path。
4. Worker 將真實值保留在 memory，只向 Gondolin 提供 placeholder mapping 與
   destination policy。
5. Lease release、expiry 或 reassignment 時移除 mapping，並撤銷 renewable credential。

HashiCorp Vault response wrapping 是可靠的選用實作：token 為單次使用、具有獨立 expiry，
且可在 unwrap 前查驗 creation path。若保留 mikan file-backed vault，則必須自行實作等價
的 scoped envelope 與 audit semantics。
([Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping))

File credential 是相容性例外。只能將明確允許的 file 投影到 lease-specific scratch
provider，優先提供 read-only access，不能 mount 整個 vault，並在 release 時清除 scratch
state。真實 secret file 一旦進入 guest，就不再適用 Gondolin 的 secret non-exposure
保證。

## 平台支援政策

### Linux

Linux + KVM 應作為 production worker baseline。Worker VM 必須提供 `/dev/kvm`；沒有
nested virtualization 或 KVM passthrough 的 cloud VM 只會 fallback 至 TCG 或直接失敗。
Worker readiness check 必須確認實際使用的 accelerator，而不只是確認已安裝 QEMU。
每個 QEMU process 使用 cgroup v2 強制 resource limit。

### macOS

macOS + HVF 適合作為 local development 與小型 worker。Gondolin 目標是維持 Linux 與
macOS 的 guest-visible behavior 一致，並記載 Apple Silicon 與受支援的 Intel Mac。
([Gondolin QEMU backend](https://earendil-works.github.io/gondolin/qemu/))

初期不能宣稱 macOS 具有與 Linux 相同的 production resource isolation。Gondolin 本身
沒有完整 resource governance，現有研究也沒有找到 macOS 上與 cgroup v2 等價的契約。
必須讓 macOS 通過相同的 conformance、load、failure 與 security test 後，再決定
production 支援等級。

## 主要風險與控制

| 風險                                  | 後果                                       | 必要控制                                                                      |
| ------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Gondolin 仍為 pre-1.0 early project   | API 或行為變動                             | 固定精確版本、包在 adapter 後、維護 Linux/macOS contract test                 |
| mikan Node 版本低於 Gondolin 要求     | 無法在最低支援版本中 in-process 整合       | 使用獨立 Node 24 worker，或明確提高 mikan 最低版本                            |
| Worker partition 後重新指派           | 兩台 VM 同時寫入相同 workspace             | Lease expiry 與 fencing epoch，由 worker 及 workspace finalizer 強制執行      |
| 錯誤假設 shared filesystem cache/lock | Stale read 或衝突寫入                      | Single writer、generation marker、filesystem-specific failure test            |
| Response 遺失後重試 `exec`            | Shell side effect 重複                     | Request ID 與 result journal；記載 at-least-once semantics                    |
| Worker 遭入侵                         | 暴露 lease-scoped host secret/workspace    | Least-privilege worker、短效 bundle、allowlist、不傳完整 vault                |
| Guest 取得 file credential            | Secret 可被讀取及外洩                      | 明確 compatibility policy、限縮 egress、短效 credential、cleanup              |
| QEMU/Gondolin DoS 缺口                | Host resource 耗盡                         | Linux cgroup、capacity admission、output/disk/time limit、worker watchdog     |
| Guest asset drift                     | Checkpoint 無法恢復或行為改變              | Content/build ID、具簽章或 checksum verification 的 image promotion、分段發布 |
| Network 不相容                        | 需要 HTTP/2、UDP 或任意 TCP 的 tool 無法用 | Curated tool/profile list 與 conformance test                                 |
| VFS 語意或效能差異                    | Package manager、watcher、大型 tree 退化   | 真實 workload benchmark 與 repository operation test suite                    |

## 成熟替代方案比較

這裡必須分開評估四件事：專案是否成熟、能否在某個 host OS 啟動 VM、是否提供本機 VM
管理面，以及是否真的包含 fleet orchestration。能在 macOS 安裝 client，不代表 macOS
可以當 worker；提供 remote API，也不代表具備 placement、lease、workspace ownership
與 secret authorization。

**目前沒有成熟且可直接取代 Gondolin 的 exact drop-in。** 成熟方案多半只解決 VM
lifecycle 或 Linux fleet；接近 mikan agent sandbox 契約的方案則仍為 pre-1.0。最強的
成熟跨平台基礎是 libvirt/QEMU 搭配 mikan 自有的小型 guest agent；libkrun 是更專精、
更低階的候選，但需要 mikan 補齊更多 control-layer 能力。

### 比較表

| 方案             | 定位與成熟度                                                                            | Worker host OS                                    | Fleet orchestration                                           | Workspace 能力                                                                 | Secret 能力                                                                              | 對 mikan 的適配結論                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Gondolin         | Pre-1.0、官方稱 early project；agent sandbox 功能完整度高                               | Linux/KVM、macOS/HVF                              | 無                                                            | VFS provider 與 host path projection；遠端 materialization 需自建              | 具 destination-bound HTTP placeholder；file secret 需自行投影                            | 功能最貼近，但 production resource governance 與長期 API 穩定性不足                                                   |
| Raw QEMU         | 成熟的通用 VM/VMM 基礎；QMP 是版本化 machine API                                        | Linux/KVM、macOS/HVF                              | 無                                                            | virtiofs、9p、block、qcow2 snapshot 與 migration primitive                     | 無 agent secret policy                                                                   | 跨平台底座最可靠，但 guest agent、exec、網路、lifecycle 與安全 hardening 幾乎全由 mikan 建造                          |
| libvirt + QEMU   | 成熟的 VM 管理 API，提供 remote access、domain、storage、network、snapshot 與 migration | Linux/KVM；macOS 可執行 QEMU/HVF server           | 只有 remote host 管理與 migration，沒有 scheduler             | virtiofs、9p、disk/volume；virtiofs state 不會隨 libvirt snapshot 一起保存     | libvirt secret 主要服務 storage encryption；不是 agent credential injection              | **跨 Linux/macOS 的成熟短名單首選**；仍需 mikan worker、guest exec protocol、secret 與 workspace generation           |
| Firecracker      | 已在 AWS production 使用的精簡 microVM VMM                                              | 僅 Linux/KVM                                      | 無                                                            | virtio-block 與 snapshot；不支援 virtiofs                                      | 無                                                                                       | Linux 隔離與啟動速度可靠，但無 macOS、host workspace attachment 差，會形成第二套 execution stack                      |
| Kata Containers  | 2017 年起的成熟 OCI/CRI runtime；QEMU、Cloud Hypervisor、Firecracker 等 backend         | Linux/KVM                                         | 自身沒有；通常交給 Kubernetes/containerd                      | OCI bundle、virtiofs、block；與 container ecosystem 整合佳                     | 依賴 Kubernetes/container runtime secret，值會進 guest workload                          | 若 mikan 已採 Kubernetes 很合理；否則為了 sandbox 引入 CRI/Kubernetes 過重，且無 macOS worker                         |
| Incus            | 有 LTS release 的成熟 VM/system-container manager                                       | **Daemon 僅 Linux**；macOS 只有 client            | **內建 cluster、placement、evacuation、rebalance 與 healing** | Host path、virtiofs/9p、custom volume、Ceph/CephFS/LINSTOR 等 cluster storage  | 支援 env 與 systemd credential，但值會傳入 instance；scoped Vault policy 仍由 mikan 負責 | **Linux production fleet 最強短名單**；直接解決最多多機問題，但不滿足 macOS worker 同引擎                             |
| E2B self-hosted  | 活躍的 agent sandbox 產品與開源 infra，Firecracker-based                                | Linux/KVM；macOS 只能作 client/deploy workstation | 有完整 API、Nomad/Consul 與 orchestrator                      | Sandbox filesystem API、upload/download、volume、snapshot/pause                | 可傳 command/global env，但官方明示 guest OS 中不保密                                    | 功能完整但部署面包含 Terraform、Packer、Nomad、Consul、Postgres、object storage、DNS/TLS；比 mikan 目標更像另一個平台 |
| Lima             | CNCF Incubating、穩定的本機 Linux VM 開發工具                                           | macOS/VZ 或 QEMU；Linux/QEMU                      | 無                                                            | 自動 host file sharing、writable mount 與 port forwarding                      | 只有 environment propagation，無 scoped secret broker                                    | 很適合 macOS local development；不是 untrusted multi-tenant sandbox 或 fleet substrate                                |
| libkrun          | 1.0 後承諾 SemVer public API，專精嵌入式輕量 VM                                         | Linux/KVM、macOS 14+ ARM64/HVF                    | 無                                                            | virtiofs、block；官方警告 VMM 可觸及的 host filesystem 也可能被 guest 間接觸及 | 無內建 secret policy                                                                     | 比 Gondolin 底層 API 穩定且符合 focused 方向，但 mikan 要自行建造 Gondolin 已提供的大部分 control plane               |
| Cloud Hypervisor | 活躍、具 API 相容承諾的 security-focused cloud VMM                                      | 僅 Linux/KVM                                      | 無                                                            | virtiofs、block、snapshot、live migration、CPU/memory resize                   | 無                                                                                       | Linux backend 能力比 Firecracker完整，但仍缺 macOS、agent exec 與 fleet；較適合作為 Kata/Incus 下的 engine            |
| microsandbox     | 最直接的 agent sandbox 候選；目前仍為 pre-1.0                                           | Linux/KVM、macOS/HVF                              | 尚無；cloud sync 官方標示 coming soon                         | OCI image、snapshot/fork；跨機 state sync 尚未可用                             | 具與 Gondolin 類似的 allowlisted TLS placeholder                                         | 功能 fit 可能高於 Gondolin，但成熟度沒有更高；應持續觀察，不應作為目前的 production foundation                        |

資料來源：

- QEMU 官方列出 Linux/KVM 與 macOS/HVF accelerator，並將 QMP 定義為版本化 machine
  API。([QEMU introduction](https://www.qemu.org/docs/master/system/introduction.html)、
  [QMP reference](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html))
- libvirt 官方確認 macOS 同時可作 client 與 QEMU driver server，remote connection
  只需更換 URI；virtiofs 可以分享 host directory，但 shared filesystem state 不包含在
  libvirt snapshot 中。([macOS support](https://libvirt.org/macos.html)、
  [remote support](https://libvirt.org/remote.html)、
  [virtiofs](https://www.libvirt.org/kbase/virtiofs.html))
- Firecracker 明確依賴 Linux KVM，提供 jailer、seccomp、cgroup integration、snapshot
  與 production host guidance；它沒有 virtiofs device。
  ([Firecracker repository](https://github.com/firecracker-microvm/firecracker)、
  [snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)、
  [Kata hypervisor comparison](https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md))
- Kata 是 OCI/CRI runtime，典型路徑為 kubelet 到 CRI、Kata、VM；所有正式 backend
  都使用 Linux KVM。([Kata architecture](https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture/README.md)、
  [virtualization](https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md))
- Incus daemon 只支援 Linux，macOS package 只有 client；其 REST API 可經 local Unix
  socket 或 remote TLS 使用，cluster 提供 evacuation、healing 與 rebalance。
  ([Incus installation](https://linuxcontainers.org/incus/docs/main/installing/)、
  [REST API](https://linuxcontainers.org/incus/docs/main/rest-api/)、
  [cluster management](https://linuxcontainers.org/incus/docs/main/howto/cluster_manage/))
- E2B self-host 使用 Terraform，AWS reference deployment 包含 Nomad/Consul server、API、
  Firecracker client、build 與 analytics node pool；Firecracker 需要 bare metal 或 nested
  virtualization。([E2B self-host guide](https://github.com/e2b-dev/infra/blob/main/self-host.md)、
  [E2B environment variables](https://e2b.dev/docs/sandbox/environment-variables))
- Lima 在 macOS 預設 VZ、Linux 預設 QEMU，提供自動 filesystem sharing；專案為 CNCF
  Incubating。([Lima documentation](https://lima-vm.io/docs/)、
  [VM types](https://lima-vm.io/docs/config/vmtype/))
- libkrun 官方承諾 1.0 後 public API 穩定，支援 Linux/KVM 與 macOS ARM64/HVF；其安全
  模型要求另外隔離 VMM 可存取的 filesystem 與 network context。
  ([libkrun repository](https://github.com/containers/libkrun))
- Cloud Hypervisor 提供 API compatibility notice、virtiofs、snapshot/live migration 與
  CPU/memory resize，但跨版本 snapshot/migration 不保證。
  ([Cloud Hypervisor repository](https://github.com/cloud-hypervisor/cloud-hypervisor))
- microsandbox 公開的 local runtime 為 pre-1.0；官方頁面將跨機 cloud sync 標為尚未
  提供。([microsandbox repository](https://github.com/superradcompany/microsandbox)、
  [official site](https://agentsandbox.dev/))

### 短名單

#### 1. libvirt + QEMU：跨平台一致性優先

這是比 Gondolin 更成熟、同時保留 Linux 與 macOS worker 的主要候選。mikan 可以把
libvirt 放在既有 `mikan-worker` 後方：本機使用 Unix socket，遠端仍只暴露 mikan 的
worker protocol，不直接將 libvirt remote API 當成產品 API。

它解決 VM definition、start/stop、resource configuration、storage/network device、
snapshot 與基本 process reconciliation。mikan 仍需要維護一個很小的 guest agent，提供
streaming exec、cancellation、health 與 workspace mount handshake；vault placeholder、
lease/fencing、placement 與 workspace generation 仍是 mikan responsibility。

主要代價是開發量高於 Gondolin。主要收益是 backend API、QEMU integration 與
production operations 的歷史更長，而且不依賴 Gondolin 的 Node runtime 與 pre-1.0 API。

#### 2. Incus：Linux production fleet 優先

若接受「macOS 是 client/local development，不是 production worker」，Incus 是整體最
成熟且能直接消除最多自建工作的方案。它已經有 cluster membership、placement、remote
TLS API、projects、resource limits、storage pool、migration、evacuation 與 healing。

mikan 仍保有 conversation lease 與 vault authorization，但不必再自行建立底層 worker
membership、VM placement、image distribution、cluster storage attachment 與 evacuation。
需要注意 Incus healing 的官方警告：網路分割時仍必須以 BMC/PDU 或 mikan fencing 確認
舊 instance 已停止，不能只相信 heartbeat timeout。

限制是 Incus daemon 僅支援 Linux。若另加 Lima/Gondolin 作 macOS local backend，就會
產生兩套 conformance matrix；這和「只支援少數 sandbox」的方向有衝突。

#### 3. Gondolin：功能適配優先

若 PoC 顯示自行建 guest agent、network broker 與 VFS policy 的成本過高，Gondolin 仍是
較務實的 adapter。它不是成熟度勝出，而是已經實作最接近 mikan 的 execution、VFS 與
secret placeholder。必須固定版本、隔離於 worker process，並保留可替換 backend
boundary。

### 排除理由

- 不選 raw QEMU：它是所有候選的可靠底座，但不是足夠深的 mikan integration layer。
- 不選 Firecracker：Linux-only 且缺 workspace filesystem sharing；其成熟度不能抵消
  產品需求不符。
- 不選 Kata：成熟但需要 containerd/CRI，fleet 通常再依賴 Kubernetes；維運面超出
  focused sandbox 目標。
- 不選 E2B self-host：功能最完整，但等於運行另一套 agent sandbox platform，部署與
  stateful dependency 遠大於成長型團隊需要的 mikan worker。
- 不選 Lima：本機開發體驗成熟，但不是 hostile-code production isolation 或 fleet
  manager。
- 不直接選 libkrun 或 Cloud Hypervisor：它們是較穩定的 VMM/library，不是完整 agent
  runtime；接上後仍需重做 Gondolin control layer。
- 不選 microsandbox：需求 fit 很高，但 pre-1.0 且跨機 sync 尚未交付，無法作為「比
  Gondolin 更成熟」的答案。

### 選型決定：Gondolin

比較完成後，決定繼續採用 **Gondolin/QEMU**。原因不是它比其他候選成熟，而是它已經
提供最接近 mikan 契約的 VM execution、VFS 與 destination-bound secret primitive，能
讓 mikan 專注於 worker、lease、workspace generation 與 vault authorization，不必另外
維護 guest agent、CRI/Kubernetes 或通用 VM cluster platform。

Gondolin 官方提供的 pi-coding-agent extension 範例進一步確認以下整合方式可行：

- `VM.create()` 搭配 `RealFSProvider`，將 host workspace 投影至 `/workspace`
- `VM.exec()` 支援 cwd、environment、streaming stdout/stderr 與 `AbortSignal`
- VM startup 使用 single-flight promise，session shutdown 時呼叫 `vm.close()`
- host absolute path 可經 escape check 映射為 guest POSIX path

範例是 integration reference，不是 production implementation。mikan 不應逐一 override
pi tool，而應在既有 `Executor` 後方加入 `GondolinExecutor`；read/write 直接使用 `vm.fs`
而不是執行 `cat` 或 base64 shell script。還必須補上：

- 每個 conversation/vault key 一個 VM，而不是 process 內單一 VM
- startup failure 後清除 rejected single-flight promise，允許 retry
- timeout/cancel 後確認 guest process 真正停止；必要時終止並重建 VM
- secret 使用 Gondolin placeholder 與 destination policy，不把真實值放進 guest env
- private workspace 使用 mount routing 組合多個 provider
- curated guest image 明確提供 mikan 所需的 shell、Git 與工具
- idle stop、resource limit、drift reconciliation 與 worker crash recovery

Gondolin 維持 pinned、replaceable adapter，不讓 backend-specific API 進入 mikan 的公開
sandbox mode 或持久 state。使用者只看到 `microvm:<profile>`；單機與多機都使用同一個
`WorkerClient`、lease、workspace generation 與 vault contract。

## 分階段建議

### Phase 0：相容性 spike

- 使用固定版本的 Gondolin/QEMU 執行獨立 Node 24 worker。
- 驗證硬體加速，測試 Linux x86_64、Linux ARM64 與目前支援的 macOS hardware。
- 測試 mikan 實際的 `bash`、read、write、edit、package install、Git、cancellation、large
  output、private workspace 與 vault HTTP flow。
- Benchmark VM cold start、warm exec、VFS operation 與具代表性的 package install；
  在寫入過程中終止 QEMU 與 worker。
- 建立 curated guest image 並驗證 manifest/checksum。

只有在必要 mikan workflow 不依賴 generic NAT、任意 Docker image 或不安全的 secret-file
mount 也能通過時，才進入下一階段。

### Phase 1：單機也經過 worker protocol

- 即使在本機，所有新的 `microvm` execution 都經過 `WorkerClient`。
- 同一台機器透過 Unix socket 執行 `mikan-worker`。
- 使用 `local-path` workspace preparation 與經 mikan host 授權的 scoped secret。
- 實作 lifecycle reconciliation、idle stop、request ID、profile 與 worker readiness check。
- 將 `image:*` 保留為過渡期 Docker fallback。

這個階段會先建立單機與多機共用的執行介面，尚不引入 distributed storage。

### Phase 2：一台 remote Linux worker

- 加入 authenticated remote transport、heartbeat、durable lease、fencing 與 capacity
  reporting。
- 先使用 shared POSIX storage，避免 workspace 啟動時大量傳輸。
- 只傳遞 lease-scoped secret bundle，並套用 Linux cgroup limit。
- 測試 host restart、worker restart、partition、storage interruption、expired secret、
  duplicate request 與 stale lease。

### Phase 3：多台 Linux worker

- 加入 sticky placement、queueing、draining、image/profile rollout 與 reconciliation。
- 每個 conversation workspace 只允許一台 writable worker。
- 只有測量確認 shared storage latency 成為問題後，才加入 Git/worktree cache。
- 將 failover 視為從 committed workspace state 重建 VM，不做 live migration。

### Phase 4：驗證 macOS worker 與進階 workspace sync

- 在 macOS/HVF 執行相同 conformance 與 failure suite。
- 對 OS control 不同的部分定義較低或 best-effort resource guarantee。
- 只有 non-Git remote workload 確實值得其維護成本時，才加入 content-addressed
  workspace generation。

### Phase 5：縮減支援的 sandbox 集合

- 將 `microvm:<profile>` 設為預設受管模式。
- 保留 `host` 供可信本機使用。
- Curated profile 證明 workload、secret、workspace 與維運功能足夠後，deprecated
  `image:*`。
- 不公開 `qemu:*` user-facing mode；QEMU 是 backend detail。
- 不將 Firecracker 加入預設矩陣。它僅支援 Linux/KVM，會形成第二套 control stack。
  ([Firecracker repository](https://github.com/firecracker-microvm/firecracker))

## 決策

選定 Gondolin/QEMU 作為 `microvm:<profile>` 的第一個 engine。Gondolin 必須固定版本、
隔離在獨立 worker process，並包在 mikan 自有的 runtime interface 後方；QEMU、Gondolin
session ID 與 backend-specific configuration 都不成為公開契約。

無論 spike 結果為何，從第一版開始都建立單一 mikan worker protocol，單機也透過它
執行。第一個遠端版本使用一台 Linux/KVM worker、shared POSIX storage、scoped
in-memory secret 與嚴格 lease/fencing；只有測量後才加入 worker-local Git cache。

這個架構適合成長中的團隊，因為由單機擴展到多機時，只需要替換 placement 與
workspace provider，不需要更換 agent、executor、vault policy 或 sandbox profile。
責任邊界也很明確：Gondolin 解決本機受控執行；可靠的 distributed state、lease、
workspace generation 與 vault authorization 由 mikan 負責。

## 第一手來源

### mikan

- `src/execution-resolver.ts`
- `src/provisioner.ts`
- `src/sandbox/container.ts`
- `src/sandbox/image.ts`
- `src/vault/index.ts`
- `src/vault/routing.ts`
- `src/commands/sandbox.ts`
- `src/tools/sandbox.ts`
- `src/content/docs/sandbox.mdx`
- `src/content/docs/sandbox/image.md`
- `src/content/docs/sandbox/vault.md`

### Gondolin

- [Repository 與 README](https://github.com/earendil-works/gondolin)
- [發布版本](https://github.com/earendil-works/gondolin/releases)
- [Host package metadata](https://github.com/earendil-works/gondolin/blob/main/host/package.json)
- [CI workflow](https://github.com/earendil-works/gondolin/blob/main/.github/workflows/ci.yml)
- [架構](https://earendil-works.github.io/gondolin/architecture/)
- [安全設計](https://earendil-works.github.io/gondolin/security/)
- [QEMU backend](https://earendil-works.github.io/gondolin/qemu/)
- [Backend capability matrix](https://earendil-works.github.io/gondolin/backends/)
- [VM lifecycle 與 execution](https://earendil-works.github.io/gondolin/sdk-vm/)
- [VFS provider](https://earendil-works.github.io/gondolin/vfs/)
- [Secret handling](https://earendil-works.github.io/gondolin/secrets/)
- [Snapshot](https://earendil-works.github.io/gondolin/snapshots/)
- [Workload lifecycle](https://earendil-works.github.io/gondolin/workloads/)
- [Custom image](https://earendil-works.github.io/gondolin/custom-images/)
- [目前限制](https://earendil-works.github.io/gondolin/limitations/)

### 平台、workspace 與 secret

- [QEMU virtualization accelerator](https://www.qemu.org/docs/master/system/introduction.html)
- [QEMU 安全模型](https://www.qemu.org/docs/master/system/security.html)
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [NFSv4.1 protocol 與 caching](https://www.rfc-editor.org/rfc/rfc8881.html#section-10)
- [Git worktree](https://git-scm.com/docs/git-worktree.html)
- [Git partial clone](https://git-scm.com/docs/partial-clone)
- [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)
- [Firecracker repository](https://github.com/firecracker-microvm/firecracker)

### 成熟替代方案

- [libvirt macOS support](https://libvirt.org/macos.html)
- [libvirt remote support](https://libvirt.org/remote.html)
- [libvirt virtiofs](https://www.libvirt.org/kbase/virtiofs.html)
- [Kata Containers virtualization](https://github.com/kata-containers/kata-containers/blob/main/docs/design/virtualization.md)
- [Incus installation 與 host OS support](https://linuxcontainers.org/incus/docs/main/installing/)
- [Incus cluster management](https://linuxcontainers.org/incus/docs/main/howto/cluster_manage/)
- [Incus storage](https://linuxcontainers.org/incus/docs/main/explanation/storage/)
- [E2B self-host guide](https://github.com/e2b-dev/infra/blob/main/self-host.md)
- [Lima documentation](https://lima-vm.io/docs/)
- [libkrun repository 與 security model](https://github.com/containers/libkrun)
- [Cloud Hypervisor repository](https://github.com/cloud-hypervisor/cloud-hypervisor)
- [microsandbox repository](https://github.com/superradcompany/microsandbox)
