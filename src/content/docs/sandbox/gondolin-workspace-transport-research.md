---
title: Workspace transport 研究:NFS 之後的路
description: gondolin:remote 多機 workspace 傳輸的替代方案研究——generation sync、fencing 與 stale-writeback 防護、業界平台先例。
---

> **Archived research:** This document records historical research for the removed remote Gondolin design. Its deployment guidance is not supported; use local `gondolin:default`.

產生日期:2026-07-15

本研究由三條平行軌道對 primary sources(RFC、man page、官方文件、論文原文、原始碼)查證合成;
每條事實主張均附出處,並區分「文件保證」與「推論」;部分 git 行為經 shell 實測確認(標 **[實測]**)。
全文三份原始軌道報告的精華已合併於此。

## 結論摘要

1. **NFS 降級為「同 LAN/VPC 部署選項」,WAN 一律改走 generation sync。** 業界調查(E2B、Modal、
   Fly、GitHub Actions、Bazel RBE、Coder、Gitpod、Daytona)**沒有任何一個平台跨 WAN 共享
   mutable POSIX filesystem**;全部是「rebuild + content-keyed cache」或「explicit-commit
   volume」兩種模式。Modal 甚至親自走過這條路:先提供 NFS 式 NetworkFileSystem,後來
   **主動 deprecate**,改推 explicit-commit 的 Volume。
2. **NFSv3 + macOS server 沒有 fencing story,這是協定層硬事實。** macOS nfsd 只支援 v2/v3
   export(man page 僅引 RFC 1094/1813),NFSv4.1 的 state revoke/delegation recall 全部用不到;
   v3 是 stateless server + async writeback,被 partition 再癒合的 client kernel 會照常 flush
   dirty pages,server 無從辨識「此 client 已被接管」。誠實的答案是 **generation markers +
   讓 stale write 落進已判死的 generation、發佈點不採納**——與 GFS「stale replica 永不參與
   mutation、擇機 GC」同構。
3. **建議的 generation 模型:照抄 jujutsu 的 working-copy-as-a-commit,用 git object store 當
   CAS。** 每個 turn 用 temp-index(`GIT_INDEX_FILE` + `git add -A [--force]` + `write-tree` +
   `commit-tree`)把整個工作樹(committed + uncommitted + untracked,可選含 ignored artifact)
   快照成一個 commit,**[實測]** 不擾動真實 index、保 executable bit 與 symlink。generation =
   snapshot commit id,以 `git push --atomic` 發佈到 host bare repo 的
   `refs/generations/<conv>/<epoch>`——單 ref 更新原子、pack negotiation 自動增量、天然對齊
   現有 lease epoch fencing。
4. **Materialization 靠平台 CoW 原語,不跨網路。** macOS 用 `clonefile(2)`、XFS/btrfs 用
   reflink(`FICLONE`);**GCP 常見的 ext4 沒有 reflink**,改用 overlayfs(lower = generation
   checkout 唯讀、upper = guest scratch),finalize 時只需序列化 upper 層。
5. **延遲算術證明 per-syscall transport 在 WAN 必死**:成本 ∝ ops 數(`git status`/`npm install`
   級 workload 為 10^4–10^6)× RTT(DERP 實測 50–280ms)→ 10^5 ops 序列化下界 2–4 小時,
   正是觀測到的 VM startup timeout。generation sync 成本 ∝ 位元組/頻寬 + O(1) RTT,與 ops
   數解耦。

## 背景與動機

### mikan 現況(已確認事實)

- 目標:mac + linux 組成可隨意擴展的 agent sandbox cluster。
- 現行 `gondolin:remote` 不搬運 workspace 檔案:host 與 worker 必須在各自 `workspaceRoot`
  看到同一個 filesystem(quickstart「Shared workspace」段)。
- 建議部署 = mikan host 自己 NFS export workspace;startup 時 `gondolin-nfs-advisory.ts`
  偵測未 export 就印出 OS 對應指令(e5aeb31)。
- 實際 mount 參數:`vers=3,resvport,nolock`;export 用 `mapall`/`all_squash` 壓平為 host uid;
  網段 100.64.0.0/10(tailscale CGNAT)。**`nolock` = NLM 全關:跨 worker 零鎖協調**,一致性
  只剩 close-to-open(v3 的 CTO 本身也只是慣例,見下節)。
- Fleet 已有:sticky placement(gondolin-placement.json)、lease watermark fencing、draining、
  reconcile(f2fa724);failover = 換 worker 重建。
- Vault credential 檔已改為 content 傳送 + per-runtime 投影(bb3bc76),不依賴 shared
  storage——先例:資料可以「以內容傳輸」而非「以掛載共享」。
- 量測到的天花板:gondolin VFS 疊在高延遲 NFS(tailscale DERP relay)上,VM startup 直接
  timeout;每個 guest syscall = FUSE/RPC→worker→NFS→host 的 RTT 乘法。
- 既定路線(gondolin-migration-research.md):選項 B(shared FS)明訂為第一版、非終局;
  Phase 3 觸發條件「量測確認 shared storage latency 成問題後,才加 Git/worktree cache」——
  **已觸發**。
- 相關懸案:workspace dir redesign X(typed mounts)/ Y(guest-local cwd)決策未定;
  `workspace/<id>` 同時是 session-store 與 guest cwd(同一 inode),是 shared-fs 需求的根源。

### 已識別的弱點

1. 落地是 NFSv3 + `nolock`,比原研究引用的 RFC 8881(v4.1)前提更弱。
2. Control-plane fencing(lease watermark)擋不住 data-plane stale writeback:被 partition 的
   worker kernel client 事後 flush dirty pages,直接落進活的 workspace(無 generation 邊界可
   吸收)。
3. mikan host = storage SPOF,而且是 macOS nfsd(消費級、會睡眠、換網路)。
4. 延遲乘法:npm install 等小檔案風暴 workload 跨 WAN 必死。
5. `mapall` + AUTH_SYS:摸得到 export 就能以 host uid 寫,邊界只剩 tailscale ACL。
6. 「隨意擴展」與單台 mac 垂直承載所有 worker I/O 矛盾。

## 延遲算術:為何 per-syscall transport 在 WAN 必死

協定事實:(1) Gondolin VFS 是 FUSE/RPC 型,每個 guest syscall 先 upcall 到 worker userspace;
(2) NFSv3 每個 LOOKUP/GETATTR/ACCESS/READ/WRITE 是一次 server round-trip,CTO + actimeo 只
快取屬性,目錄遍歷與 metadata-heavy 操作仍逐 op RTT;(3) stat storm 是真實的——git 之所以
加 fsmonitor daemon,正是為了避免 `git status` 掃描整棵樹
([git-fsmonitor--daemon](https://git-scm.com/docs/git-fsmonitor--daemon));`npm install` 對
node_modules(動輒數萬檔)做大量 open/stat/rename/write。推論:真實 workload 一次操作發出
**10^4–10^6 級** FS ops。

| 情境                          | 單邊 RTT(下界)                                                                | 10^4 ops 序列化下界 | 10^5 ops 序列化下界 | 判定                                          |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------- | ------------------- | --------------------------------------------- |
| same-LAN(同交換機)            | ~0.5ms                                                                        | ~5 秒               | ~50 秒              | 勉強可用(靠並行)                              |
| same-VPC(同雲同區)            | ~1ms                                                                          | ~10 秒              | ~100 秒             | 臨界                                          |
| cross-region direct WireGuard | ~30ms                                                                         | ~5 分               | ~50 分              | **不可用**                                    |
| DERP relay                    | 50–280ms([Tailscale KB 1257](https://tailscale.com/kb/1257/connection-types)) | ~13–25 分           | **~2–4 小時**       | **完全不可用(= 觀測到的 VM startup timeout)** |

generation sync 的成本 ∝ 變更位元組數 ÷ 頻寬 + O(1) 次 RTT(一次批次傳輸 + 一次 atomic
publish),**與 ops 數解耦、與 RTT 幾乎無關**——這就是全部被調查平台都選內容批次同步而非
逐 syscall 掛載的原因。

## NFS 語意精確盤點(fencing 缺口)

- **Close-to-open 一致性只在 open/close 邊界**:client 在 `open()` 時 GETATTR 檢查、`close()`
  時 write-back;man page 直接承認「There are still opportunities for a client's data cache to
  contain stale data.」([nfs(5)](https://man7.org/linux/man-pages/man5/nfs.5.html))。RFC 1813 更
  根本:「Neither the NFS version 2 protocol nor the NFS version 3 protocol provide a means of
  maintaining strict client-server consistency」([RFC 1813](https://www.rfc-editor.org/rfc/rfc1813));
  v3 的 Weak Cache Consistency 是提示性,不是一致性協定。
- **屬性快取 staleness window**:`acregmin=3s`/`acregmax=60s`/`acdirmin=30s`/`acdirmax=60s`——
  即使無 partition,一個 worker 的變更另一 worker 最長 60 秒看不到([nfs(5)](https://man7.org/linux/man-pages/man5/nfs.5.html))。
- **Async writeback + stateless server = partition 後 stale flush 無解**:dirty pages 可在 client
  kernel page cache 停留任意久(直到 fsync/close/記憶體壓力);v3 server 「does not need to
  maintain state about any of its clients」([RFC 1813](https://www.rfc-editor.org/rfc/rfc1813))。
  被判死的 worker A 網路癒合後,其 kernel 照常 flush——server 無 client state、無 lease,無從
  辨識「A 已被接管」。COMMIT 的 write verifier 只偵測 _server_ crash,不偵測 _client_ 被 fence。
- **NLM 是 advisory 且 partition 下最無力**;mikan 現行 `nolock` 連 NLM 都關了。
- **NFSv4.1 有 fencing 原語但 mikan 用不到**:v4.1 有 sessions/EOS、lease、state revoke、
  delegation `CB_RECALL`([RFC 8881](https://www.rfc-editor.org/rfc/rfc8881))——但 **macOS nfsd
  只支援 v2/v3 export**(macOS `man nfsd`/`man exports` 僅引 RFC 1094 與 v3 spec;`man nfs.conf`
  的 NFSv4 選項全是 `nfs.client.*`)。只要 mac host 當 NFS server 就鎖死在 v3。
- **Server 端 fencing 只擋未來 RPC**:改 export 表 / IP 封鎖不會回滾已寫入資料,對
  partition-then-heal 來得太晚。

**結論(Q:NFSv3 + macOS server 有無實務 fencing story?)**:沒有。只能「generation markers +
accept-stale-writes-into-dead-generations」——stale write 寫進已被判死的 generation 目錄,發佈
點驗證 epoch 後不採納。

## 業界先例:沒有人跨 WAN 共享 mutable POSIX FS

| 平台             | workspace 怎麼搬                                                                                                                                | 出處                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| E2B              | 每 sandbox 本地隔離 FS;OverlayFS(唯讀 rootfs lower + 可寫 ext4 upper);進出靠 filesystem API                                                     | [docs](https://e2b.dev/docs/filesystem)、[OverlayFS blog](https://e2b.dev/blog/scaling-firecracker-using-overlayfs-to-save-disk-space)           |
| **Modal**        | **explicit-commit Volume**(commit/reload、last-writer-wins、明文「不支援 distributed file locking」);NFS 式 NetworkFileSystem **已 deprecated** | [Volumes](https://modal.com/docs/guide/volumes)、[NetworkFileSystem](https://modal.com/docs/guide/network-file-systems)                          |
| Fly.io           | volume 綁死同一台實體機(「tied to that hardware」、一 volume 一 Machine);跨機靠 fork,同步是應用責任                                             | [volumes overview](https://fly.io/docs/volumes/overview/)                                                                                        |
| GitHub Actions   | 每 job fresh checkout + content-keyed **immutable** cache(`hashFiles()` key、不可改既有 cache)                                                  | [caching docs](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows) |
| Bazel RBE        | 每 action 從 CAS materialize input root,無共享 mutable FS                                                                                       | [remote-apis](https://github.com/bazelbuild/remote-apis)                                                                                         |
| Coder            | per-workspace volume(PVC/雲 disk),persistent/ephemeral 由 Terraform 宣告                                                                        | [architecture](https://coder.com/docs/admin/infrastructure/architecture)                                                                         |
| Gitpod(Flex/Ona) | `/workspace` **backup-on-stop 到 object storage、restore 到全新容器**                                                                           | [backup/restore](https://www.gitpod.io/docs/configure/self-hosted/latest/backup-restore)                                                         |
| Daytona          | archive 把整個 sandbox FS 搬到 object storage,restore 再回來                                                                                    | [sandboxes](https://www.daytona.io/docs/en/sandboxes/)                                                                                           |

**Modal 是最具指示性的先例**:他們提供過 NFS 式共享 volume,結論是 deprecate 它、改推
explicit-commit + last-writer-wins + 明示不支援分散式鎖——mikan 的 generation sync 該長的樣
子,Modal 已經替我們走過並選了 commit 模型。Gitpod 的 tar-to-object-store-on-stop 幾乎就是
generation 快照發佈流程。

## Fencing 模式(production 系統怎麼做)

貫穿全部案例的原則:**fencing token 由儲存/資源端驗證,不由 client 自律**——這正是 NFSv3
缺的一層。

- **GFS chunk version number**(SOSP 2003):master 每次授 lease 就遞增 version 並先通知
  up-to-date replicas;「The client or the chunkserver verifies the version number when it
  performs the operation」;stale replica「never be involved in a mutation… garbage collected at
  the earliest opportunity」;應用慣例「寫完再 atomic rename 成正式名」
  ([GFS paper](https://research.google/pubs/the-google-file-system/))。→ mikan 的 generation
  watermark 應在 host 發佈點驗證,而非信任 worker。
- **Chubby sequencer + lock-delay**(OSDI 2006):sequencer(lock name + mode + generation
  number)由資源 server 驗證並拒絕 stale holder;對無法驗證 sequencer 的資源,備援是
  **lock-delay**——等一段時間讓舊 holder 的 in-flight 操作作廢
  ([Chubby paper](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/))。
- **Kubernetes Lease**:只決定「誰是 owner」,不 fence data plane
  ([Leases docs](https://kubernetes.io/docs/concepts/architecture/leases/))——印證 mikan 現有
  lease 是正確的 control-plane 層,但必須另配 store 端驗證。
- **STONITH/SBD**:當 store 無法驗證 token(dumb NFS server 正是這種情況),業界答案是物理
  移除舊 writer——對 mikan:failover 前 kill 舊 worker 的 microVM / unmount / 撤 tailscale
  ACL,或等一個 lock-delay。
- **Object store conditional write = fenced publish 的黃金原語**:S3 `If-None-Match`(2024-08
  GA)/`If-Match`(2024-11)與 GCS `ifGenerationMatch`——在 store 端 CAS 驗證,衝突回 412
  ([S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、
  [GCS preconditions](https://cloud.google.com/storage/docs/request-preconditions))。直接對應
  mikan「發佈 gen N+1 必須 CAS on gen N」。

## 同步引擎評估(guest-local cwd 的傳輸層)

| 面向         | Mutagen                                                     | rsync(SSH, ≥3.4.0)                             | Unison                    | Syncthing       | DevPod 式(git clone + tar-stream) |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------- | ------------------------- | --------------- | --------------------------------- |
| 天生模型     | 持續 daemon(可 `flush` 成一次性)                            | **一次性叫用**                                 | 一次性                    | 持續多主 daemon | **一次性**                        |
| 單寫入者契合 | `one-way-replica` 佳                                        | 佳(`--delete`)                                 | 尚可                      | 差(為收斂設計)  | 最佳                              |
| Tree 交易性  | **無**(中斷留部分樹)                                        | **無**(`--delay-updates` 只縮小視窗)           | 較佳                      | 無              | 無(tar 中斷不可續)                |
| 屬性保真     | **僅 executability**                                        | `--perms`/`--xattrs`/`--hard-links`/`--sparse` | 部分                      | 有限            | tar 可帶                          |
| 授權/維護    | MIT + **SSPL 預設打包**(v0.17+);release 慢(v0.18.1/2025-02) | GPLv3 CLI spawn,活躍                           | GPLv3;自陳 2.5 人/0.1 FTE | MPL-2.0         | 自建                              |

- **Mutagen**:`one-way-replica` 語意最吻合單寫入者(([sync docs](https://mutagen.io/documentation/synchronization/));
  檔案層 temp+rename 原子但**無 tree 交易、無 rollback**(原始碼
  [transition.go](https://github.com/mutagen-io/mutagen/blob/master/pkg/synchronization/core/transition.go));
  只傳播 executable bit([permissions](https://mutagen.io/documentation/synchronization/permissions/));
  SSPL 自 v0.17 起預設打包進官方 binary([LICENSE](https://github.com/mutagen-io/mutagen/blob/master/LICENSE.md))。
- **rsync**:delta 演算法、`--delay-updates` 集中落地、`--link-dest` hardlink 世代化;走 SSH
  (非 daemon)+ 釘 ≥3.4.0 避開 CVE-2024-12084 風險面
  ([man](https://download.samba.org/pub/rsync/rsync.1)、[advisory](https://github.com/advisories/GHSA-85h7-m8c3-v9wc))。
- **Unison / Syncthing 不建議**:前者維護度過低 + OCaml runtime;後者是持續多主 daemon,與
  lease 單寫入者衝突([BEP v1](https://docs.syncthing.net/specs/bep-v1.html))。
- **Remote-dev 先例**:VS Code Remote / JetBrains / Coder 是「別搬資料、把運算搬過去」——
  mikan 因 Gondolin VFS 需要 worker-local 真實目錄而不能純套用;**DevPod 最貼近**:git source
  在 worker 端 clone(`--git-clone-strategy` full/blobless/treeless/shallow/bare)、local 髒檔
  以一次性 tar-stream 上傳([tunnel.proto](https://github.com/loft-sh/devpod/blob/main/pkg/agent/tunnel/tunnel.proto)、
  [clone.go](https://github.com/loft-sh/devpod/blob/main/pkg/git/clone.go))。Skaffold/Tilt 的
  **fall-back 語意**值得借鏡:某些變更(刪除、lockfile)直接放棄增量、全量重建
  ([Skaffold filesync](https://skaffold.dev/docs/filesync/)、[Tilt live_update](https://docs.tilt.dev/live_update_reference.html))。
- **共同結論**:沒有任何引擎提供 tree 層級交易性。mikan 必須自帶「generation 完整性契約」:
  同步進暫存目錄 → manifest/digest 驗證 → **整個 generation 目錄原子 rename 就位** → 才切
  active 指標。這把「單檔原子」升級成「整世代原子」,並與 fencing epoch 對齊。

## Git 與 content-addressed generation

### 捕捉整棵工作樹(含未提交/untracked)——核心原語

- **[實測]** `git stash create`(無旗標)**不**捕 untracked;`stash push -u` 是 3-parent commit
  (第 3 parent 存 untracked)但會擾動工作樹(stash 完 `git clean`)
  ([git-stash](https://git-scm.com/docs/git-stash))。
- **[實測] 正解 = temp-index snapshot**:`GIT_INDEX_FILE=<tmp> git read-tree HEAD && git add -A
&& git write-tree`——完全不碰真實 index/工作樹,把 tracked 修改 + untracked 快照成 tree;
  `add -A --force` 可連 ignored artifact 一起收;正確保存 `100755` executable 與 `120000`
  symlink。限制:git tree 只有 4 種 mode,**不保存完整 unix 權限、uid/gid、mtime、xattr**。
- **jujutsu 印證此模型可運維**:jj「automatically create commits from the working-copy contents
  when they have changed」,working copy 就是一個持續快照的 commit;stale workspace 的復原
  (`jj workspace update-stale` 建 recovery commit)與 mikan failover 語意高度相似
  ([jj working-copy.md](https://github.com/jj-vcs/jj/blob/main/docs/working-copy.md))。mikan
  不需引入 jj,照抄模式即可。

### 傳輸與發佈

- **單 ref 更新是原子的**(receive-pack「fully succeeds or fails completely」);多 ref 用
  `git push --atomic`([git-push](https://git-scm.com/docs/git-push))。→ generation 指標做成
  `refs/generations/<conv>/<epoch>`,push 即 fenced publish 的載體。
- **pack negotiation 自動增量**:push snapshot commit N+1 只傳 host 缺的 object,未變 blob 靠
  SHA 去重零傳輸——「大量小檔、少量變動」的最佳情況,免自建 FindMissingBlobs。
- **partial clone 不可作常駐形態**:文件明載需線上,promisor 斷線後任何觸及未抓 blob 的操作
  失敗且無 fallback([partial-clone](https://git-scm.com/docs/partial-clone))——與 worker 會
  partition 的前提直接衝突;只能當冷啟動「先跑起來」的加速。
- **git bundle** = 天生的「一檔一 generation」離線 artifact(可經 scp/S3/HTTP 搬運、
  `bundle verify` 驗完整性);增量 bundle 是 thin pack,failover 到全新 worker 需回退全量
  ([git-bundle](https://git-scm.com/docs/git-bundle))。
- **git worktree**:共享 object store、per-worktree HEAD/index;lock 是 admin-file 保護不是
  併發鎖;多 conversation 共用一個 worker-side cache 時各自 checkout detached commit 即不相撞
  ([git-worktree](https://git-scm.com/docs/git-worktree))。

### CAS 先例的設計提煉

- **REAPI v2**:Digest =(hash, size_bytes)、Merkle tree sorted by UTF-8 byte order、
  `FindMissingBlobs` 增量上傳;基礎模型只保 `is_executable`(與 git tree 相同),完整
  `unix_mode`/`mtime` 是選配 NodeProperties——若日後要補權限/xattr,這是現成欄位設計
  ([remote_execution.proto](https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto))。
- **Buildbarn ADR-0009 直接印證 mikan 的失敗**:macFUSE「system lockups under high load」且已
  閉源;lazy 虛擬 FS「low concurrency → poor execution times for file system intensive
  operations」;他們的 NFS 是 **localhost 低延遲**,mikan 的是跨地域高延遲——根本錯配
  ([ADR-0009](https://github.com/buildbarn/bb-adrs/blob/main/0009-nfsv4.md))。
- **OSTree**:content-addressed store + hardlink-farm checkout + 原子 ref + static delta;但強綁
  「checkout 出的檔必須 immutable」模型,對 guest 自由讀寫的 workspace 不直接適用(除非配
  overlayfs 當唯讀 lower),整合成本高([docs](https://ostreedev.github.io/ostree/))。
- **casync 已休眠(2017)**;**desync 活躍(v1.0.3, 2026-06)**,catar + S3/HTTP/SSH store,
  是「巨檔內部小改 sub-file 去重」成為主訴求時的 plan B
  ([desync](https://github.com/folbricht/desync))。
- **NAR**:決定性、只認 executable bit、忽略 mtime 的樹序列化——語意恰好等同 git tree,用了
  git 就不需另借 NAR([NAR spec](https://nix.dev/manual/nix/stable/protocols/nix-archive))。

### Materialization 速度原語(worker 端)

| 原語              | 平台/FS                        | 備註                                                                                                                                                                                                                |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clonefile(2)`    | macOS APFS                     | CoW clone 整棵目錄樹;同 volume 限定([man](https://keith.github.io/xcode-man-pages/clonefile.2.html))                                                                                                                |
| `FICLONE` reflink | **btrfs、XFS**;**ext4 不支援** | 同 FS 限定([man](https://man7.org/linux/man-pages/man2/ioctl_ficlonerange.2.html))                                                                                                                                  |
| hardlink farm     | 任意 POSIX                     | 檔案須 immutable(寫入會污染 CAS);OSTree/Buildbarn 模型                                                                                                                                                              |
| **overlayfs**     | Linux 任意(lower 唯讀)         | **ext4 worker 的最佳解**:lower = generation checkout、upper = guest scratch;finalize 只序列化 upper;注意 whiteout/opaque dir/跨層 rename `EXDEV`([kernel docs](https://docs.kernel.org/filesystems/overlayfs.html)) |

雲端硬約束:AWS Amazon Linux 2 root = XFS(有 reflink);GCP COS 生產推薦與多數 Ubuntu
image = **ext4(無 reflink)**([GCP docs](https://docs.cloud.google.com/container-optimized-os/docs/concepts/supported-filesystems))。

## 建議架構(三軌綜合)

**主幹:git-as-CAS 的 workspace generation。** 兩個 strawman(A:git bundle + 髒檔補充包;
B:git-agnostic 全 content-addressed 樹)的融合——用 B 的統一模型、拿 git object store 當
CAS,實作面積最小(host/worker 都已裝 git;pack 協商、fsck、gc 都是現成的):

1. **Lease start(materialize)**:worker 從 host bare repo `fetch` 目標 generation commit →
   checkout 成 worker-local 真實目錄(= Gondolin `RealFSProvider` 的來源)→ 依 FS 用
   clonefile/reflink/overlayfs 開可寫副本。非 git 的 workspace 一樣適用:用 shadow bare repo +
   `GIT_WORK_TREE` 快照任意目錄。
2. **Turn 執行**:guest I/O 全部落在 worker 本地磁碟,零跨網路 syscall。
3. **Finalize(publish)**:temp-index snapshot commit → `git push --atomic` 到
   `refs/generations/<conv>/<epoch>`;host 端 pre-receive/發佈點驗證 epoch(**CAS on gen N**,
   GCS `ifGenerationMatch` 語意的本地複刻)——stale worker 的 push 被拒,寫進死 generation
   的資料永不被採納。
4. **Failover**:STONITH 精神(kill 舊 worker microVM / 撤 ACL)或 Chubby lock-delay → 遞增
   epoch → 新 worker 從最後 committed generation 重建(步驟 1)。
5. **Host 端 generation store**:bare repo + per-conversation 保留策略(最近 N 代 + 時間過期,
   prune 前確認無 active lease 引用);`git fsck` 驗完整性;發佈點 atomic rename + fsync。

**輔助通道**(依量測需要才加):rsync over SSH(≥3.4.0)搬「刻意不進 generation 的大型
artifact」;desync 處理巨檔 sub-file 去重;node_modules 優先 worker 端 `npm ci` 重建,或以
`--force` 收進 snapshot(量測後決定,git 對「大量小檔少量變動」的去重本來就強)。

**NFS 的新定位**:同 LAN/VPC 部署選項,加三道自動化 admission gate:

1. `tailscale ping` 必須是 direct(「via <IP:port>」),一旦 DERP 就拒絕 NFS 模式;
2. 實測 RTT ≤ ~2ms;
3. 結構性要求同 LAN/VPC,跨 geography 一律 generation sync。

**與 X/Y 決策的關係**:本方案就是 Y(guest-local cwd)的具體化——workspace generation 是
session-store 與 guest cwd 分離後的自然介面。X(typed mounts)不解決 per-syscall 跨網路的
根本問題。建議以此研究為 Y 案定調的依據。

## 風險與待驗證項

| 風險                                                    | 控制                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| mac↔linux case collision(APFS case-insensitive vs ext4) | materialize 時偵測僅大小寫不同的路徑並報錯;host 端 case-collision 檢查                                    |
| 檔名 Unicode 正規化(macOS NFD)                          | 需實測 git/rsync/tar 行為;必要時正規化政策                                                                |
| xattr / 完整 mode / mtime 不保存                        | git tree 語意對多數 workspace 足夠;需要時走 REAPI NodeProperties 風格 sidecar manifest                    |
| absolute symlink 跨 host/worker 失效                    | 保留相對 symlink;absolute symlink 偵測 + 策略決定                                                         |
| 巨檔小改整 blob 重傳                                    | 量測後才上 desync(CDC)plan B                                                                              |
| bare repo 膨脹                                          | per-conversation 保留策略 + `git gc`;GC 與 lease/epoch 對齊(只 prune 已 finalize 且無人持有的 generation) |
| ignored artifact 收不收                                 | 做成 per-profile policy(`add -A` vs `add -A --force` + pathspec),參考 Tilt fall_back_on 的顯式宣告        |
| tar/rsync 中斷留部分樹                                  | generation 完整性契約:暫存目錄 + digest 驗證 + 原子 rename,失敗即整代重來(冪等)                           |

## 分階段建議

- **G0(立即、低成本)**:NFS admission gate(DERP 偵測 + RTT 門檻,超標拒絕並指路
  generation sync)——把「NFS 只適合同 LAN」從文件註記變成程式強制。同時做 spike:
  temp-index snapshot + `push --atomic` 到 `refs/generations/*` 的原型,量 node_modules 級樹的
  snapshot/push/fetch/checkout 時間。
- **G1**:host bare repo generation store + finalize/materialize 雙向流程 + epoch CAS 驗證;
  failover 改走 generation 重建。此階段需要 X/Y 決策定案(建議 Y)。
- **G2**:materialization 加速(clonefile/reflink/overlayfs 依 FS 選路)+ fsmonitor 縮小
  finalize 掃描;保留策略與 GC。
- **G3**:NFS 正式降級為 same-LAN 選項並文件化;跨 WAN 部署移除 shared-storage 前置需求。

## 開放決策問題

1. X/Y 決策:是否以本研究為 Y(guest-local cwd)定調?
2. node_modules 等 ignored artifact:worker 端重建 vs 收進 generation(等 G0 量測)?
3. generation store 位置:host bare repo(建議)vs 外部 object store(S3/GCS conditional
   write 原生支援 fencing,但引入雲依賴)?
4. turn 進行中是否需要連續回寫(若是,再評估 Mutagen;v1 不需要)?
5. macOS nfsd 無 v4 路線——same-LAN NFS 是否也值得換成 Linux host 才提供的 v4.1?(建議:
   不值得,same-LAN 下 v3 + 單寫入者夠用,工程投資應全數投入 generation sync。)

## 第一手來源(彙整)

### NFS 協定與 man page

- RFC 1813(NFSv3):https://www.rfc-editor.org/rfc/rfc1813
- RFC 8881(NFSv4.1):https://www.rfc-editor.org/rfc/rfc8881
- nfs(5):https://man7.org/linux/man-pages/man5/nfs.5.html
- Linux NFS client-identifier:https://docs.kernel.org/filesystems/nfs/client-identifier.html
- macOS `man nfsd` / `man exports` / `man nfs.conf`(本機查證,v3-only server)

### Fencing 與協調

- The Google File System(SOSP 2003):https://research.google/pubs/the-google-file-system/
- Chubby(OSDI 2006):https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/
- Kubernetes Leases:https://kubernetes.io/docs/concepts/architecture/leases/
- S3 conditional writes:https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- GCS request preconditions:https://cloud.google.com/storage/docs/request-preconditions

### 平台先例

- E2B filesystem:https://e2b.dev/docs/filesystem;OverlayFS blog:https://e2b.dev/blog/scaling-firecracker-using-overlayfs-to-save-disk-space
- Modal Volumes:https://modal.com/docs/guide/volumes;NetworkFileSystem(deprecated):https://modal.com/docs/guide/network-file-systems
- Fly.io volumes:https://fly.io/docs/volumes/overview/
- GitHub Actions caching:https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows
- Coder architecture:https://coder.com/docs/admin/infrastructure/architecture
- Gitpod backup/restore:https://www.gitpod.io/docs/configure/self-hosted/latest/backup-restore
- Daytona sandboxes:https://www.daytona.io/docs/en/sandboxes/

### Git / CAS

- git-worktree:https://git-scm.com/docs/git-worktree;partial-clone:https://git-scm.com/docs/partial-clone;git-bundle:https://git-scm.com/docs/git-bundle;git-stash:https://git-scm.com/docs/git-stash;git-push:https://git-scm.com/docs/git-push;git-fsmonitor--daemon:https://git-scm.com/docs/git-fsmonitor--daemon
- Jujutsu working-copy:https://github.com/jj-vcs/jj/blob/main/docs/working-copy.md
- REAPI v2 proto:https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/remote_execution.proto
- Buildbarn ADR-0009:https://github.com/buildbarn/bb-adrs/blob/main/0009-nfsv4.md;bb-remote-execution:https://github.com/buildbarn/bb-remote-execution
- OSTree:https://ostreedev.github.io/ostree/(repo/formats 子頁)
- casync:https://github.com/systemd/casync;desync:https://github.com/folbricht/desync
- NAR spec:https://nix.dev/manual/nix/stable/protocols/nix-archive

### 同步引擎與 remote-dev

- Mutagen:https://mutagen.io/documentation/synchronization/(permissions/ignores/symbolic-links 子頁);LICENSE:https://github.com/mutagen-io/mutagen/blob/master/LICENSE.md;transition.go:https://github.com/mutagen-io/mutagen/blob/master/pkg/synchronization/core/transition.go
- rsync man:https://download.samba.org/pub/rsync/rsync.1;CVE-2024-12084:https://github.com/advisories/GHSA-85h7-m8c3-v9wc
- Unison:https://github.com/bcpierce00/unison/blob/master/README.md
- Syncthing BEP v1:https://docs.syncthing.net/specs/bep-v1.html
- DevPod:https://github.com/loft-sh/devpod(tunnel.proto、tunnelserver.go、pkg/git/clone.go)
- Skaffold filesync:https://skaffold.dev/docs/filesync/;Tilt live_update:https://docs.tilt.dev/live_update_reference.html
- VS Code Remote FAQ:https://code.visualstudio.com/docs/remote/faq

### 平台原語

- clonefile(2):https://keith.github.io/xcode-man-pages/clonefile.2.html
- ioctl_ficlonerange(2):https://man7.org/linux/man-pages/man2/ioctl_ficlonerange.2.html
- copy_file_range(2):https://man7.org/linux/man-pages/man2/copy_file_range.2.html
- overlayfs:https://docs.kernel.org/filesystems/overlayfs.html
- Tailscale connection types(KB 1257):https://tailscale.com/kb/1257/connection-types
- GCP COS filesystems:https://docs.cloud.google.com/container-optimized-os/docs/concepts/supported-filesystems
