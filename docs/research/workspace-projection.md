# Workspace projection 隔離設計研究

> 研究日期：2026-07-28。範圍是 `src/workspace-projection/` 及其目前會到達的 sandbox backend；不修改 production code。

## 摘要與建議

目前的 `WorkspaceProjection` 是一個小而清楚的**掛載規劃器**，不是完整的安全邊界：`private` 只產生四個可寫來源（`MEMORY.md`、`skills/`、`events/`、當前 conversation 目錄），`full` 則暴露整個 workspace。真正的隔離強度取決於消費該規劃的 backend。今天只有 managed Docker image 與 Gondolin 實際消費這些 mounts；host、既有 container、Firecracker、Cloudflare 並未得到同等的 private projection。

建議採分階段的混合方案：

1. **短期保留明確 bind/VFS mounts**，因為它是 image/Gondolin 上最低複雜度、近乎零拷貝且即時可見的方案；但把它明確定位為「可見性縮減」，而非抵禦惡意 host workspace 的唯一邊界。
2. **先補安全不變量與 adversarial 測試**：來源必須是預期型別、不得是 symlink、以 canonical path 驗證仍在 workspace 下；Docker 改用 `--mount` 並要求來源已存在；Gondolin 也需驗證 `RealFSProvider` 的解析語義。這些檢查仍有 check/use race，不能宣稱完全消除 TOCTOU。
3. **需要跨 backend 一致性或較強快照隔離時，導入 materialized generation**：由 host/control plane 建立每 conversation 的 staging tree，再把單一 tree 交給 runtime。publish/write-back 用 generation/CAS，而不是逐檔盲目覆寫。
4. **不要單獨採 tool-layer allowlist 當 sandbox 邊界**：agent 的 `bash` 可啟動任意程式，任何只包住 `read`/`write`/`edit` 的政策都可被繞過。若要 enforcement，應下沉到 OS/VFS（例如 Linux Landlock、mount namespace、Gondolin provider），tool policy 只作 defense-in-depth 與較好的錯誤訊息。

## 研究方法與標記

- **[觀察]**：直接由本 repository 原始碼、測試或官方文件確認。
- **[實測]**：本機可重複實驗；命令與結果列於文末。
- **[假說]**：合理但尚未由本專案 end-to-end 測試證明，附驗證方式。
- 外部資料只引用官方文件、kernel 文件或 system-call man page。

## 目前設計：實際發生什麼事

### 規劃與設定權限

**[觀察]** `resolveWorkspaceProjection()` 先拒絕空值、`.`、`..`、斜線、反斜線與 NUL 的 conversation id；無 workspace 時回傳空 mounts。`full` 將 root 掛到 `/workspace`；`private` 先建立 conversation 目錄，再產生四個 mount，全部未標 `readOnly`（`src/workspace-projection/index.ts:12-36,61-72`）。型別本身只有 `mode` 與通用 `ContainerMount[]`，沒有來源型別、同步語義或 trust level（`src/workspace-projection/types.ts:1-7`）。

**[觀察]** per-conversation mount 設定已移到 host-only state dir。註解明載舊位置位於可寫 conversation 目錄，guest 可把自己從 `private` 改成 `full`，造成跨 conversation 存取；migration marker 防止 guest 稍後重新植入舊設定（`src/config.ts:258-273`）。這證明「policy metadata 不可放在 policy subject 可寫的 tree」是現有威脅模型的一部分。

**[觀察]** workspace/package/vault mount 在 resolver 合併；vault target 與 protected target 或其他 vault target 重疊時 fail closed，先做 POSIX normalize 再比父子關係（`src/execution-resolver.ts:165-205`）。這保護的是 **target namespace collision**，不是 host source 的 canonicalization。

### 各 backend 的真實邊界

| Backend            | 是否消費 projection | 現況與邊界                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| managed `image:*`  |                  是 | resolver 將 image 轉為每 actor managed container（`src/execution-resolver.ts:105-120`）；provisioner 用 Docker `-v source:target[:ro]`（`src/provisioner.ts:277-285`），container 再加 `cap-drop=ALL`、`no-new-privileges`、PID limit（`src/provisioner.ts:316-335`）。guest 對可寫 bind 的變更即時落 host。 |
| `gondolin:default` |                  是 | directory 由 `RealFSProvider`（可選 `ReadonlyProvider`）提供（`src/sandbox/gondolin.ts:404-430`）；single-file 因 guest mount point 型別限制而在 boot 複製，workspace file 定時 sync-back（`src/sandbox/gondolin.ts:97-109,432-440,496-540`）。它不是與 Docker 完全相同的 consistency model。                |
| `container:<name>` |                  否 | 只 `docker exec -w /workspace`；既有 container 的 mount 由 operator 預先決定，且 exec 無法新增 bind。官方專案文件也標為 self-managed、無 private mode（`src/content/docs/sandbox.mdx:26-35,66-82`）。                                                                                                        |
| `host`             |                  否 | shell 直接在 host spawn，無 filesystem mediation（`src/sandbox/host.ts:22-55`）。private projection 在此沒有安全意義。                                                                                                                                                                                       |
| `firecracker:*`    |                  否 | 驗證 operator 提供的 host path，但執行透過 SSH，假定 guest `/workspace` 已自行掛好（`src/sandbox/firecracker.ts:90-107`；`src/content/docs/sandbox.mdx:32,75-76`）。                                                                                                                                         |
| `cloudflare:*`     |                  否 | bridge 只收到 `sandboxId`、command、cwd、env（`src/sandbox/cloudflare.ts:69-113`），host workspace 不自動同步（`src/content/docs/sandbox.mdx:33,76`）。                                                                                                                                                      |

因此 portability 不能只問「能否接受 mount list」，還須指定 transport、更新可見性、write-back、crash consistency 與 ownership。

### Gondolin 已揭示的同步代價

**[觀察]** single-file write-back 以 hash 比較 guest 與 last-known host；host 若已變更則將 guest 內容另存 conflict file；否則 staging + rename 原子替換。同步有 per-source lock 與 stale-lock recovery（`src/sandbox/gondolin.ts:496-540`）。這比「最後寫者直接覆蓋」安全，但仍是逐檔模型；directory mount 則直接透過 provider 存取 host。

**[觀察]** 測試覆蓋 file/directory 分流、credential 不回寫、週期與 close-time sync、host/guest conflict、兩 runtime 序列化、stale lock recovery（`test/gondolin-lifecycle.test.ts:506-678`）。現有 resolver 測試也覆蓋 unsafe conversation id、private/full mount composition、刪除後重建與 target collision（`test/execution-resolver.test.ts:38-209`）。

## 方案比較

### A. 現行明確 bind mounts / backend-native VFS

**具體設計**：control plane 解析 policy 成 typed mount list；Docker bind host path，Gondolin 使用 provider；只有必要 tree 進入 guest。

**優點**

- **正確性/效能**：directory 近乎零拷貝；host 與 guest 對同一 backing tree 操作，適合 build、watcher、git 與大量小檔。
- **操作簡單**：不需 staging GC、diff/publish 或衝突 UI；目前程式與 60 個相關測試已建立成熟基線。
- **增量政策清楚**：target collision 已集中在 resolver；read-only 也可沿 `ContainerMount.readOnly` 傳到 Docker/Gondolin。

**限制與風險**

- Docker 官方明示 bind mount 預設可寫，container process 可建立、修改、刪除 host 檔；bind 也強依賴 daemon host 的目錄結構，remote daemon 無法直接 bind client 檔案。來源：[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)。
- Docker 官方亦說 `--volume` 在 source 不存在時會自動建立目錄，而 `--mount` 會直接報錯；現行使用 `-v`，因此 support file 缺失或型別錯誤可能 fail-open 成「空目錄 mount」式的語義漂移，而非明確失敗。來源同上；repo 實作見 `src/provisioner.ts:277-285`。
- **symlink/TOCTOU**：目前 conversation id 是安全 segment，但 source 並未 `lstat`/`realpath` 驗證。`ensureDirExists()` 到 Docker/Gondolin 開啟來源之間，另一 host actor 可交換 path。即使先 `realpath`，字串檢查與真正 open/mount 仍非原子。Linux `openat2()` 的 `RESOLVE_BENEATH`、`RESOLVE_IN_ROOT`、`RESOLVE_NO_SYMLINKS` 正是為受限路徑解析提供 kernel-enforced guarantees；普通 `realpath` 無法等價取代。來源：[openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html)。
- 這不是跨 backend abstraction：Docker 是 kernel bind；Gondolin directory 是 userspace provider，file 是 copy/sync；既有 container/remote backend 根本不採用。

**適用**：單 host、可信 control plane、workspace 本身不由敵對 host process 同時改造，且需要即時共享 mutable tree。

### B. staged / materialized projection（建議作為強隔離與可攜層）

**具體設計**：每個 runtime generation 建立獨立 staging root，例如 `<state>/projections/<actor>/<generation>/workspace`。只 materialize allowlisted inputs；檢查所有 entry 型別與 symlink policy。runtime 只看 staging tree。結束時產生 manifest/diff，以「base generation 仍為 N」的 CAS 條件 publish，衝突則保留新 generation 而不覆蓋 host。

Materialization 可有三個實作層次：

1. portable baseline：逐檔 copy；
2. 同檔案系統優化：reflink/copy-on-write（能力探測後使用）；
3. Linux：read-only lower + per-runtime overlayfs upper/work。

Node 官方 `fsPromises.cp()` 可 recursive copy，且 `dereference` 預設為 `false`，但它只是 copy API，並不自動提供 allowlist、原子 snapshot 或 race-free traversal；這些仍需上層協定。來源：[Node.js `fsPromises.cp`](https://nodejs.org/api/fs.html#fspromisescpsrc-dest-options)。OverlayFS 官方文件定義 lower/upper 合併、whiteout/opaque directory 與 rename 限制，意味 publish 不能天真地只 copy upper 可見檔案。來源：[Linux OverlayFS](https://docs.kernel.org/filesystems/overlayfs.html)。

**優點**

- guest 看不到 staging 外的 sibling conversation，即使 tree 內 symlink 指向 `../C999`，只要 staging root 沒 materialize C999，解析也無目標；還可選擇直接拒絕 symlink。
- 天然支援 remote/Cloudflare/Firecracker：projection 變成 tar/CAS/object manifest transport，不依賴 host bind API。
- generation 提供可重現 input、審計、rollback 與 crash 後 GC；write-back 可以 transaction/CAS 思考，不再混合即時 mount 與輪詢 sync。

**代價**

- 初始 copy 與額外磁碟；`node_modules`、git object、build cache 會放大 latency/容量。
- host 與 guest 不再即時一致；watcher、外部 editor 與同時執行的 conversations 必須有明確 publish/refresh 行為。
- symlink、hardlink、socket/device、xattr、mode、mtime、sparse file、case sensitivity 都要定義。若 dereference symlink，materializer 可能在 copy 時讀出 allowlist 外資料；若保留 symlink，publish 時又需避免逃逸。
- staging traversal 本身仍有 TOCTOU；高安全需求要用 directory fd + constrained resolution（Linux 可用 `openat2`），或從 immutable snapshot/CAS materialize。

**適用**：remote backend、需要可重現/審計、workspace 來源可能不可信，或跨 conversation 隔離必須強於「選幾個 host path 掛入」。

### C. tool/filesystem policy enforcement

這其實包含兩種安全強度完全不同的版本。

#### C1. 只在 mikan tools 做 allowlist

在 `read`/`write`/`edit` 前 normalize + canonicalize，限制到 conversation roots；優點是跨 OS、錯誤訊息佳、容易 telemetry。可是 `Executor` 同時公開任意 `exec(command)`（`src/sandbox/types.ts:75-114`），shell 內的 `cat`、Python、compiler、Git 不走 tool wrapper。故 **C1 不能作 security boundary**，只能降低誤操作。

#### C2. OS/VFS enforcement

Linux Landlock 讓 unprivileged process 對自己及 descendants 限制 ambient filesystem rights；規則以 filesystem object hierarchy 建立，但 ABI 隨 kernel 演進，應探測版本，且文件特別說 policy 只限制施加後對新開啟檔案的存取，既有 open fd 不受影響。來源：[Linux Landlock userspace API](https://www.kernel.org/doc/html/latest/userspace-api/landlock.html)。Gondolin 可在 provider 層做同型 allowlist；Docker 則可用 mount namespace + read-only binds，必要時再在 entrypoint 套 Landlock。

**優點**

- 所有 guest process 都受限，不只內建 tools；可保留原 tree 的低拷貝與即時語義。
- policy 可表達 read-only support files、read-write conversation tree，比目前全部可寫更細。

**限制**

- Landlock 是 Linux-only；macOS、Windows、Cloudflare、Gondolin 各需不同 enforcement，portable abstraction 只能是 policy IR，不是共同 mechanism。
- enforcement 若在 guest 內啟用，必須保證無任何命令在 sandbox 套用前執行，且不能遺留危險 fd；啟動順序是安全關鍵。
- VFS/provider 實作必須正確處理 symlink、rename、hardlink、`..`、mount crossing；自行寫 policy filesystem 的驗證面很大。

**適用**：作 A 或 B 的 defense-in-depth；Linux managed runtime 可優先採用，不能取代 remote transport。

### D. immutable lower + ephemeral upper（B 的 Linux 特化）

把允許的 host snapshot 作唯讀 lower，每 conversation 以 overlay upper 寫入；完成後將 upper 解讀為 diff 並 CAS publish。它兼具 B 的 snapshot 與接近 A 的啟動/儲存效率，但 kernel 官方語義包含 whiteout、opaque dir、跨 layer rename 可能回 `EXDEV` 等細節，且 Docker Desktop/macOS 的 backing filesystem 行為不同。故它適合作為 materializer 的 Linux acceleration，**不宜成為對所有 backend 的 public contract**。來源：[Linux OverlayFS](https://docs.kernel.org/filesystems/overlayfs.html)。

## 橫向評估

| 面向                         | A bind/VFS                   | B materialized generation                    | C1 tool allowlist | C2 OS/VFS enforcement  | D overlay specialization |
| ---------------------------- | ---------------------------- | -------------------------------------------- | ----------------- | ---------------------- | ------------------------ |
| 對任意 shell 程式有效        | 是，限 mounted view          | 是，限 staged view                           | **否**            | 是                     | 是                       |
| 跨 backend portability       | 低                           | **高（以傳輸/manifest 為介面）**             | 高但非邊界        | 低至中                 | Linux-only               |
| 即時 host/guest 一致         | **高**（Gondolin file 例外） | 低，需 publish                               | 不改變            | 不改變                 | generation-based         |
| symlink escape 抗性          | 依 backend/source 驗證       | 可很高，但 traversal 要安全                  | 易被 bash 繞過    | 可高                   | 可高                     |
| TOCTOU                       | mount/open 前有 race         | snapshot traversal/publish 有 race，CAS 可控 | check/use race    | kernel resolution 最強 | snapshot 建立仍需處理    |
| 啟動成本                     | **最低**                     | 最高（可 CAS/reflink 改善）                  | 低                | 中                     | 中低                     |
| 操作複雜度                   | **最低**                     | 高（GC、publish、conflict）                  | 中                | 高且平台分裂           | 高                       |
| 適合當主要 security boundary | 有條件                       | **是**                                       | 否                | 是                     | 是（Linux）              |

## 實驗與測試結果

### Repository regression suite

**[實測]** 執行：

```bash
npx vitest --run \
  test/workspace-projection.test.ts \
  test/execution-resolver.test.ts \
  test/config.test.ts \
  test/gondolin-lifecycle.test.ts \
  test/provisioner.test.ts
npm test -- --reporter=dot
```

結果：focused suite 為 `5` 個 test files、`109` tests；完整 suite 為 `111` 個 test files、`1517` tests，全部通過（Vitest 4.1.10）。focused suite 驗證 mode fallback、host-authoritative settings、conversation path/symlink 拒絕、mount composition、collision、managed Docker lifecycle 與 Gondolin projection/sync 行為；完整 suite則檢查修改未破壞其他模組。這仍不等於驗證 mount 建立時的競態或所有 backend。

### Docker adversarial symlink probe

**[實測]** 環境：Docker client 29.6.2、server 29.5.2、`alpine:3.21`。建立 `C123 -> C999` 作 bind source；container 中 `/workspace/C123` 是空目錄，沒有讀到 C999。再把 `C123/leak -> ../C999/secret.txt` 掛進 container，因 container namespace 內沒有 `/workspace/C999`，讀取失敗。將 C123 用 `cp -a` materialize 到只含 C123 的 staging root，該 symlink 仍存在，但在 container 中同樣無法解析 C999。

這個結果只證明**此 Docker Desktop 版本與此相對 symlink case**沒有洩漏；不能推廣為所有來源重定向、absolute symlink、hardlink、Gondolin provider 或 mount 建立期間競態的保證。完整核心命令：

```bash
ln -s C999 "$root/C123"
docker run --rm -v "$root/C123:/workspace/C123" alpine:3.21 ...
ln -s ../C999/secret.txt "$root/C123/leak"
docker run --rm -v "$root/C123:/workspace/C123" alpine:3.21 cat /workspace/C123/leak
cp -a "$root/C123" "$stage/C123"
docker run --rm -v "$stage:/workspace" alpine:3.21 cat /workspace/C123/leak
```

後兩次 `cat` 均為 `No such file or directory`；materialized symlink 仍為 `../C999/secret.txt`。

## 尚待實驗驗證的假說

1. **[假說] `-v` 對缺失 `MEMORY.md` 會建立 directory 並造成 runtime drift。** 驗證：在 Linux daemon 與 Docker Desktop 各跑一次缺檔 private projection，inspect `.Mounts` 與 host inode type；再與 `--mount type=bind` 比較。官方文件預期前者建立目錄、後者 fail。
2. **[假說] source 在 resolve 與 provision 間被反覆 rename/symlink swap，可能讓不同 backend 看見非預期 inode。** 驗證：一個程序高頻交換 `C123` 與 symlink，另一程序反覆 provision 1,000 次；記錄 Docker inspect source、guest sentinel 與 Gondolin provider 讀值。這是 race test，不應用單次通過宣稱安全。
3. **[假說] generation staging 對一般 conversation tree 的 cold-start 可接受，但對 `node_modules` 不可接受。** 驗證 corpus：1k 小檔、100k 小檔、1/10/100 GiB 大檔；比較 copy、reflink、tar、CAS、overlay 的 p50/p95 materialize、首次 command、publish、磁碟放大率。
4. **[假說] generation CAS 能消除現行 shared file 的 lost-update 類別。** 驗證：兩 actor 同 base generation 修改 `MEMORY.md` 與 directory rename/delete；只允許一個 CAS publish，另一個必須產出可恢復 conflict generation。
5. **[假說] tool allowlist 在有 bash 時可直接繞過。** 驗證：讓 read tool 拒絕 sibling，然後執行 `bash -c 'cat ...'`。預期 host/full mount 可讀，private mount/OS enforcement 才真正阻擋。
6. **[假說] Gondolin `RealFSProvider` 對 absolute/relative symlink、hardlink 與 rename crossing 的語義不等同 Docker。** 驗證同一 corpus 跑 Docker 與 Gondolin，對 read/write/rename/unlink 結果做差分測試；在沒有此證據前，不把 provider 視為 kernel bind 的等價物。

## 建議的驗收規格

若進一步實作，不先選技術，而先固定以下 backend-neutral contract：

1. `private` 可讀/可寫集合分開聲明；support files 是否真的需要 writable 要逐項決策。
2. guest 無法讀 sibling conversation、host-only settings、vault source；用 bash、Python、symlink、hardlink、rename、absolute path 都測。
3. 定義 updates：live、turn snapshot 或 session generation；定義 crash、abort、concurrent publish 與 conflict recovery。
4. 所有 materialized entry 有 manifest（path、kind、mode、content hash；必要時 xattr），拒絕 device/socket/FIFO，symlink policy fail closed。
5. source validation 與 open 盡量為同一 kernel operation；Linux 用 dirfd/`openat2` constrained resolution。無法達到的 backend 必須降低 security claim，而不是靜默 fallback。
6. capability matrix 應由 runtime 回報：`liveMount`、`snapshotProjection`、`filesystemPolicy`、`atomicPublish`。不支援 private 的 backend 要明確拒絕或標為 self-managed，不能僅回傳空 mounts。
7. adversarial suite 至少涵蓋：缺失/錯型 support path、root 與 nested symlink、hardlink、mount target normalize/collision、rename race、兩 actor 同步寫、kill -9、磁碟滿、跨 device rename、case collision、100k files。

## 心得

1. **小模組不代表小安全面。** `workspace-projection` 只有約百行，卻跨越 policy ownership、path resolution、container mount、userspace VFS、同步與 remote transport。介面若只叫 `mounts`，容易把不同 consistency/security semantics 偽裝成相同能力。
2. **目前最值得保留的是 policy decision 的集中化。** conversation id 驗證、host-authoritative settings、target collision 都方向正確；真正缺的是 source identity 與 backend capability 被型別化。
3. **隔離與同步是同一個設計問題。** 一旦不再直接共享 host inode，就必須回答 snapshot、publish、衝突與 GC；Gondolin single-file projection 已經局部付出這個成本。與其每個 backend 各自長出同步例外，generation contract 更可能成為深而可攜的模組。
4. **最佳答案不是全面替換 bind mount。** 本地 trusted image build 的 hot path，bind mount 仍極有價值；materialization 應用於高隔離、remote 與 reproducibility 場景，並以 capability/policy 選擇，而非一刀切。
5. **tool policy 很有用，但名稱必須誠實。** 它是 guardrail，不是 sandbox。只要提供任意 shell，security claim 就必須落在 process 所見的 filesystem namespace 或 kernel/VFS enforcement。

## Primary sources

### Repository

- `src/workspace-projection/README.md:1-8`
- `src/workspace-projection/index.ts:12-97`
- `src/workspace-projection/types.ts:1-7`
- `src/config.ts:258-273`
- `src/execution-resolver.ts:105-120,165-205`
- `src/provisioner.ts:277-335`
- `src/sandbox/gondolin.ts:97-109,404-440,496-540`
- `src/sandbox/{host,firecracker,cloudflare}.ts`
- `src/sandbox/types.ts:75-145`
- `src/content/docs/sandbox.mdx:25-82`
- `src/content/docs/sandbox/gondolin.md:15-35`
- `test/execution-resolver.test.ts:38-209`
- `test/gondolin-lifecycle.test.ts:506-678`

### External official sources

- Docker, Bind mounts: https://docs.docker.com/engine/storage/bind-mounts/
- Linux kernel, Overlay Filesystem: https://docs.kernel.org/filesystems/overlayfs.html
- Linux kernel, Landlock userspace API: https://www.kernel.org/doc/html/latest/userspace-api/landlock.html
- Linux man-pages, `openat2(2)`: https://man7.org/linux/man-pages/man2/openat2.2.html
- Node.js, `fsPromises.cp`: https://nodejs.org/api/fs.html#fspromisescpsrc-dest-options
