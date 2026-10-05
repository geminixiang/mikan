# mikan 跟隨哪一條 Pi 路線？SDK、durable 與 JSONL 的重新研究

> 初次研究日期：2026-10-05。由主 agent 獨立研究，未使用 agent team／subagent。第 1～10 節保留實作前的觀察；當時只新增文件與離線 POC，未改 production code 或依賴。後續使用者批准的本地升級與精簡見第 11 節。整個工作未上 prod VM、呼叫付費模型、執行真實平台 E2E、commit、push 或部署；先前 production 檢查只作交接證據。

## 後續方向：保留 durable，精簡 mikan 接縫

使用者已決定繼續使用 pi-durable，後續目標是減少 mikan 自有維護責任，不是切換正式 coding-agent SDK。下列比較保留為決策證據，而非 SDK 遷移計畫。

使用者已批准將四個 Pi／Chord dependencies 升級並精確固定為 1.0.2。本地 POC、回歸測試與精簡已完成：以公開 ProviderDoc／request sessionId 取代 message-object tagging、WeakMap owner routing 與 sessionId fallback；仍保留 mikan 的預算、授權、sandbox 隔離和呈現責任。沒有新增 scheduler／checkpoint 或相容層，尚未 commit、push、做真實平台 E2E 或部署。

## 結論先讀

1. **Pi 有兩條並行路線，不是全體改用 durable。** 正式 `pi-coding-agent@1.0.2` 的預設 CLI／SDK 是 `Agent + AgentSession + SessionManager`，持久化為 JSONL；同版本 repo 的實驗 coding TUI 與 client/server 已使用 pi-durable。後者是 source-only，未成為正式 SDK 的 runtime。不能說「Pi 自己完全不使用 durable」，也不能宣稱「正式 coding-agent 將必然改用 durable」。[P1][P2][P3]
2. **mikan 以前已經使用 Pi 的 experimental harness，不是正式 coding-agent SDK。** 這次是跟隨原 experimental 子系統的替代者，但同時換了資料模型和 storage topology；不只是把原 API 升一個版本。[P4][M1]
3. **pi-durable 確實是 durable execution framework。** Tasks、checkpoint、scheduler、document revisions 和 recovery 是它的核心，不是 SQLite 偶然多出幾張 table。「沒有手寫 nodes／edges」不足以排除 LangGraph 類型的複雜度；LangGraph 自己也有 Functional API。[P5][L1]
4. **SDK 是真實可行的候選，不能只用『偏 CLI』排除。** 公開 SDK 有 headless 執行、持久化、fork、compaction、retry、stop／steer、tool operations 注入。本輪 POC 驗證 headless 模型／工具迴圈、注入讀檔和持久化 fork，不只是閱讀 README。[P6][E1]
5. **目前 durable 最明確的結構優勢，是共享 storage 內不複製父歷史的 fork，加上按需讀取的 SQLite。** 不是模型變聰明、只有它能摘要／fork，也不是 DB 必然更小。恢復和 atomic committed state 有額外價值，但 mikan 現在會 abort 上次留下的工作，沒有交付「重啟後自動完成工作」的產品能力。[P5][M2][E1]
6. **建議暫不動 production，也不要繼續把 durable 當成唯一 Pi 路線。** 如果目標是跟隨日常使用的正式 Pi coding-agent、維持可直接閱讀的 session，SDK 應是優先驗證的替代方向。若大量 context-inheriting threads 的複製成本不可接受，或產品真的要 committed live state／durable recovery，durable 仍是合理選擇。這份研究不足以批准 production 切換：完整 sandbox、budget、MCP、恢復與資料遷移尚未做等價驗證。

## 1. 版本與證據邊界

| 對象                    | 本輪基準                                                   | 如何查證                                              |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| mikan 原始碼            | `fe168bcfdadebb3dde9d8cedc6eace719d4d456e`，beta.93        | 本 checkout                                           |
| 遷移前 mikan            | `c1a1741a545ed8a5ccaaea395a111412cb705da2`，beta.88        | 獨立 detached worktree，未切換共用 checkout           |
| 本機 mikan dependencies | durable／agent-core／ai／Chord **1.0.0**                   | 已安裝 package.json                                   |
| 本機正式 coding-agent   | **1.0.2**，其自身 ai 為 1.0.2                              | 已安裝 package、公開入口與 SDK POC                    |
| 第一方 Pi source        | tag **v1.0.2**，`cd32f7725fdbddbaecdff5b1e68491563394e0ca` | 固定版本 worktree；GitHub tag API 交叉核對            |
| 官方最新 release        | 查詢當時為 **v1.0.2**，2026-10-04 發布                     | GitHub releases API；不拿本機版本推論 latest          |
| production              | 前次交接為 mikan beta.92／durable 1.0.2／Node 24.21        | 本輪未登入、未重測                                    |
| POC 執行環境            | Node **24.14.1**，SDK 1.0.2、durable 1.0.0                 | 本機，非 production Node、非同版本跨 runtime 性能裁判 |

讀取第一方 SDK／session format／compaction／sessions／settings／message types 文件、工具與 session source、durable README／spec／實作 handoff／Chord guide，以及 mikan README、tests、ADR 和 git history。線上搜尋只將第一方命中的內容作來源；搜尋未命中不作不存在的證據。

**本機測試綠燈不等於 production 1.0.2 已驗證。** 這個版本差異影響下文 provider identity 的結論。

## 2. Pi 到底在發展什麼？

### 2.1 三個套件不是同一層

| 套件              | 本身負責                                                                                                                   | 本身不提供／注意事項                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pi-agent-core`   | Agent、模型／工具 loop、events、in-memory transcript、steering／follow-up／abort                                           | 不再有舊 SessionRepo／AgentHarness、持久化 backend、compaction engine；裸 core 不等於完整 coding-agent  |
| `pi-coding-agent` | AgentSession、SessionManager JSONL tree、compaction、retry、工具、resources／extensions、ModelRuntime；正式 CLI 與公開 SDK | 沒有 durable task scheduler 的承諾；預設 resources、host tools、auth 和設定不適合直接拿來當隔離服務     |
| `pi-durable`      | 自己的 generation／tool tasks、atomic commit、conversations、documents、checkpoint／recovery、觀察 committed state         | 不是 core Agent 外掛；建在 pi-ai／Chord 上。README 明示 **Experimental，API 可在 release 間無預告改變** |

core 1.0.0 移除的是 **experimental harness**；官方 changelog 的「Use pi-durable for durable sessions」不是「所有 Agent／coding-agent 都必須用 durable」。[P1][P4][P5]

### 2.2 正式與實驗 coding-agent 同時存在

- 正式 `package.json` 無 pi-durable dependency；`sdk.ts` 建立 `new Agent(...)`；`SessionManager` 寫 JSONL。[P1]
- `src/experimental/durable/README.md` 展示 SQLite Harness、restart recovery、subagents、live task panel。[P2]
- `src/experimental/services/README.md` 明示 client/server 是 source-only，排除於 npm packages／standalone binaries；worker 用 durable，還有 tree navigation、subagent service、歷史 paging 等 TODO。[P3]
- 歷史 commits `5609b0d6c`、`48dd1e2f0` 在 1.0.0 前已建立這些實驗路徑，不是因 mikan 後來採 durable 才出現。

**觀察**：maintainers 真正在試驗 durable 架構，正式 SDK 暫時仍採另一套。

**未知**：沒有在查閱的第一方資料找到承諾正式 SDK 改用 durable 的發布時程。實驗程式存在，不是既定 roadmap；正式 SDK 未換，也不是 durable 被否定的證明。

### 2.3 mikan 不是原本跟著正式 CLI，現在突然偏離

遷移前 `src/sessions/session-store.ts` import `AgentHarness`、`JsonlSessionRepo` 和 `NodeExecutionEnv` from pi-agent-core／其 node subpath。這本來就是被 1.0 刪掉的子系統。[M1]

因此：

```text
正式 Pi CLI／SDK：Agent → AgentSession → SessionManager JSONL

mikan 舊路線：experimental AgentHarness → JsonlSessionRepo v4
mikan 新路線：pi-durable Harness → shared conversations → SQLite
```

這解釋了當時選 successor 的理由，但**沒有證明 successor 最符合 mikan 的長期需要**。選正式 SDK 是另一條整合路線，不是單純「恢復以前的 JSONL」。舊 v4 harness 格式與 SDK 的 v3 session 格式也不是同一種 JSONL。[P4][P7][M1]

## 3. 把三項變更拆開

| 變更                                          | 真正得到什麼                                                                                            | 不是什麼                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| JSONL backend → SQLite backend                | SQL 索引、按需讀取、transaction backend、SQLite backup snapshot                                         | 不會讓 LLM 更聰明；不是 compaction／fork 的必要條件；大小未必較小 |
| 每 session storage → 每 office shared storage | fork 引用同 storage 的父 entries，避免把相同上下文寫入每個 thread；集中 listing／history                | 會擴大損壞影響範圍；共享 lifetime／writer／model routing 更複雜   |
| 舊 harness → durable execution model          | 請求、task、document state 的 atomic commits；重啟後可檢查／恢復 checkpoints；committed view 與部分輸出 | 不是 SQLite 才能做；也不是所有外部副作用 exactly-once             |

### 3.1 真正相對於 SDK 的額外能力

1. **Committed state 與可重新附著的 view**：durable 的 generation partial、tool progress、inbox 等進入儲存，watch/event 從 commits 派生。SDK 的 streaming state／queue 不是同一種 durable 狀態；v1.0.2 `AgentSession._handleAgentEvent` 先 emit public／extension events，再處理 `message_end` persistence。這是有來源的具體語義差異。[P5][P8]
2. **跨 record／document 的 atomicity**：一個 commit 可以同時寫 entry、task outcome 和 document，而不是多個獨立 JSONL append。[P5]
3. **Recovery 與 replay policy**：工具 intent 先 commit；重啟時安全工具可 rerun，unsafe 工具回 interrupted。可恢復的是 phase／checkpoint，不是把普通 async function 任意停在某行再續跑。[P5]
4. **不複製父歷史的 conversation fork**：SDK fork 可以保留相同上下文，但持久化為另一份 root-to-leaf JSONL；同 file 的 branch 也有 fork 類效果，但一個 SessionManager 只有一個 active leaf，不能直接當多個獨立 thread 的多 writer runtime。[P7][E1]

### 3.2 mikan 目前用了多少？

**已用**：shared fork／reset、SQLite indexed reads、conversation usage／live state、generation／tool execution、retry／compaction、committed events。

**沒有交付**：部署重啟後無人介入、自動把所有 Slack 工作做完。`OfficeStorage.openShared()` 先 `inspect()`，再對 ownerless unfinished tasks `abortTask()`；因為直接 submit 會啟動整個 storage 的 scheduler，可能跑出沒有 runner 呈現的 headless 工作。[M2]

目前 subagents 是 mikan 自己啟動 bounded in-memory sessions，不是 durable README 中跨 restart 的 owned child conversations。不能把 README 的全部能力算成 mikan 已得到的收益。[M3]

**安全邊界**：unsafe replay 不等於外部 effect exactly-once。若外部 API 已成功而 outcome 未 commit，仍是未知；後續模型也可能決定重新呼叫。需要 effect-specific idempotency／查證。SQLite `WAL + synchronous=NORMAL` 的 process-crash 保證也不等於斷電／host failure 不丟最新 commit；durable JSONL 預設 `fsync=false` 同樣不能當 power-loss 保證。[P5]

## 4. 它有沒有變成 LangGraph？

**有共同問題域，不能以『不是 graph』敷衍。** LangGraph 的 Functional API 不要求寫 StateGraph，仍有 entrypoint、tasks、checkpoint、resume／replay 和 idempotency 要求。[L1]

但兩者不是相同 runtime：

- durable 的常見聊天 loop 已內建為 `pi.generation`／`pi.tool`，mikan 不必定義每個 node／edge。
- durable 自訂 tasks 是 explicit phases／checkpoint state machine；LangGraph Functional API 的恢復描述是重新進入 entrypoint 並復用已記錄 task 結果。不能假定所有 replay／checkpoint 語義相同。[P5][L1]
- durable 是 Pi 自己的框架，package 並不依賴 LangChain／LangGraph；這不意味著它沒有框架成本。

如果討厭的是「必須理解 checkpoint、scheduler、state lifecycle 才能維護」，那這次確實跨進了該類設計；資料表只是可見的結果。判斷應看 mikan 必須知道多少 runtime 細節，而不是品牌名稱。

## 5. 公開 SDK 能不能實際支援 mikan？

| mikan 需求               | coding-agent 公開 SDK                                            | durable                                          | 還需要 mikan 負責                                          |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Headless Agent loop      | `createAgentSession`／`prompt`，本輪已驗證                       | Harness submit／wait                             | 平台 intake、回覆呈現                                      |
| 持久化對話／tool results | SessionManager JSONL                                             | Entries／Storage                                 | Office paths、資料隔離、備份                               |
| Thread fork              | 持久化複製選定 branch；本輪已驗證                                | 同 storage 引用父 entry                          | 選定 Slack run 的 fork 點與 provenance                     |
| `/new`                   | new session 或 manager branch 操作，需決定產品語義               | Conversation.reset 保留 raw history              | 平台 sync cursor、memory 不變性                            |
| Compaction／retry        | SDK 自帶；source／docs 查證，未呼叫付費摘要                      | 自帶，另有背景 compaction                        | 預算／用量呈現、策略適配                                   |
| Stop／steer              | abort／waitForIdle／steer／followUp                              | conversation abort／inbox submissions            | 目標定位、授權、Slack stop notice                          |
| Sandbox coding tools     | 公開 read／write／edit／bash operations；read 注入已驗證         | ExecutionEnv                                     | 真正 sandbox 的安全路徑、執行、mounts、憑證                |
| 多 thread 同時工作       | 一個 AgentSession／SessionManager per thread；完整並行整合未驗證 | 一個 Harness，多 conversations                   | queues、resource cap、runner eviction                      |
| Provider identity        | SessionManager ID 原生傳給請求；本輪已驗證                       | **1.0.2 原生** per-conversation ProviderDoc      | budgets、credentials／model catalog 與 observability       |
| 任意 host metadata       | CustomEntry                                                      | Documents／custom entries                        | schema、保留／fork policy                                  |
| Durable task recovery    | 不是 SDK 已承諾的 task checkpoint runtime                        | 原生                                             | 重啟政策與重新接上 responder                               |
| Session view／history    | branch entries、JSONL；跨 session 搜尋由 host 組合               | conversation context／entries／committed watches | Slack 因果與 UI、權限                                      |
| MCP／codemode            | 正式公開 builtin extension factories；SDK 非預設自動啟用         | mikan 現有 durable tool integration              | 連線生命週期、授權、secret redaction；本輪未做完整等價 POC |

官方 full-control example 可以替換 resource loader、settings、model runtime、session manager，不必讀取真實使用者的 `~/.pi`、project extensions 或 AGENTS.md。operations API 明確支援 remote／SSH；所以「只適合本機 CLI」是錯誤排除理由。[P6]

**限制也要承認**：SDK public root 包含 CLI／TUI exports，不是一個只帶 agent loop 的超小 package。完整 SDK 的 services 與 policy 也有複雜度。預設 coding tools 在 host 執行、extensions 在 host process 執行；只有明確注入／禁用，才符合 mikan isolation。不能只設 `cwd` 就宣稱 sandbox 安全。

SDK 的 `sessionManager` 是具體 SessionManager 型別，不是 generic SQLite storage interface。**不能承諾把現有 SQLite 塞進 SDK 就全部保留**；那會變成 mikan 自己維護 importer、journal 或另一個 storage bridge。這和直接採 SDK JSONL 是不同方案。[P6][P7]

## 6. mikan 自己現在背負的額外接縫

| 接縫                  | 已查證事實                                                                                                | 影響與版本注意                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Shared Harness pool   | OfficeStorage refs、bindings、writers、default extensions=[]                                              | 與一 session 一 AgentSession 的生命週期不同；不能只數上游 features                                     |
| Request owner routing | copied last-message object＋WeakMap，Models Proxy 找 conversation owner                                   | 依賴 generation 不複製 message objects；README 明示不是公開契約；用於各 session budgets／models        |
| Provider identity     | 1.0.0 缺 native ID；1.0.2 的 ProviderDoc 為每 conversation 新 UUID，generation／compaction 都傳 sessionId | 前面「durable 缺 affinity」只對 1.0.0 成立；新 API 可降低例外，但不能未實測就說 budgets routing 全解決 |
| Summary recognition   | mikan 比對 durable summary wrapper 的原始字串                                                             | 私有文案變化可能影響識別；SDK 自己有 typed compaction entry                                            |
| Recovery policy       | open 時 abort unfinished tasks                                                                            | 安全保守，但主動不採 automatic recovery 的主要產品能力                                                 |
| Runtime-wide settings | Harness settings getters 讀 latest binding                                                                | 需要不同 concurrent session settings 的測試矩陣；本輪不宣稱已發現 production bug                       |
| mikan↔Pi adapter      | SessionStore、MikanAgentSession、tool adapters、events、budget hooks                                      | 任何路線都需要邊界；SDK 也不會消除 Office／Slack 語義                                                  |

[P9][M2][M3][M4]

特別要注意：mikan wrapper 的 `withSession` **保留 options 已帶的 sessionId**，不是無條件覆寫。升到 durable 1.0.2 後 native ProviderDoc ID 不一定是舊 mikan index ID；本機 `office-sessions.test.ts` 目前用 1.0.0 驗證「request ID 等於 SessionStore ID」。需要在 deployment 的精確版本重驗，不能把本機綠燈當成已相容。這是待驗的 contract 差異，不是本輪證明了 production cache 壞掉。[P9][M4]

### 6.1 到底少了多少自有程式？

比較遷移前 commit `c1a1741a` 與本輪 `fe168bcf`，固定計數：harness/session、execution-env、pi-tools、sessions/session-store、舊 store、compaction-summary。

| 指標                                  | Before | After | 解讀                                  |
| ------------------------------------- | -----: | ----: | ------------------------------------- |
| 上述 runtime adapter 行數             |  2,495 | 2,282 | 少 213 行，約 8.5%                    |
| 再納入新增 v4 reader／SQLite importer |  2,495 | 2,822 | 多 327 行，遷移成本不能消失           |
| `harness/session.ts`                  |  1,024 |   919 | loop wrapper 有縮減                   |
| `sessions/session-store.ts`           |    792 |   907 | shared storage／conversation 管理增加 |

這是固定路徑的 physical line count，不是 complexity 指標、完整 codebase 比較或單一變更的因果證明；其間有其他修改。不能用一個大 commit 的刪行數，宣稱整個整合已更簡單。

另有版本風險：package.json 是 `^1.0.0`，本地安裝／lock 與既有 production 版本不一樣；ADR 0017 所說「pinned deliberately」應區分 lockfile pin 與 package 的 caret range。對明示 API 可無預告改變的 dependency，重現部署版本特別重要。[M5]

## 7. 本輪離線 POC：公平比較能回答什麼？

可重跑腳本：[pi-runtime-research.mjs](../../scripts/experiments/pi-runtime-research.mjs)。不使用網路模型／平台；僅合成資料與 faux stream。透過公開 exports 使用 APIs，optional global SDK 從 package.json 宣告的 public ESM entry 載入，沒有依賴 private method。

```bash
PI_CODING_AGENT_PACKAGE=/path/to/pi-coding-agent/package.json \
  node --expose-gc scripts/experiments/pi-runtime-research.mjs
```

前提：mikan 既有 dependencies 與已安裝 coding-agent；本輪未安裝任何套件。這個 POC 的 optional global SDK 部分使用其同目錄的 ai dependency，非 production loader。

### 7.1 行為驗證

- 用 SessionManager public API 寫 300 則 parent messages。
- 建 100 個 persistent fork，各追加 40 則；每個 child context=340、parent仍=300，沒有真實 user text。
- durable JSONL 與 SQLite 做同樣的 reference fork，驗證相同 context message count。
- public SDK＋custom resource loader＋in-memory settings／SessionManager＋offline provider，跑 **assistant tool call → injected read → final answer**。
- 注入的 read operation 被呼叫 1 次，provider 2 次；第二次 request 確實包含 virtual sandbox tool result，final text 符合 fixture；兩次 request 都帶 SDK session ID。

**證明**：headless＋remote operations injection＋完整父 context 的 fork 在公開 API 層可行。

**沒有證明**：真實 Docker／mount／credentials isolation，完整 stop／steer races、MCP grants、budget enforcement、production provider cache、crash/power-loss guarantees，或一次升級即可替換 mikan。

### 7.2 對照數字

合成資料：parent 300 則、100 個 fork、每 child 新增 40 則、正文約 2 KiB／則。SDK 寫入獨立 JSONL；durable 的兩種 backend 均是一個 shared Harness storage。這是**相同繼承上下文的產品語義**，不是假裝三者 file layout 相同。

每種 open scenario 用獨立 process 跑 3 次，列中位數；imports 後才計時，OS cache 未清除，**不是 cold-start／import cost 或 production latency**。Heap 是 GC 後相對 baseline 增量，不是 total RSS。

| 指標                               | SDK JSONL 1.0.2 | durable JSONL 1.0.0 | durable SQLite 1.0.0 |
| ---------------------------------- | --------------: | ------------------: | -------------------: |
| 關閉後 storage                     |   **72.07 MiB** |        **9.08 MiB** |        **17.23 MiB** |
| 開一個 SDK session／shared storage |         1.14 ms |            59.26 ms |              2.05 ms |
| 開啟後 heap 增量                   |        0.61 MiB |           10.83 MiB |             0.10 MiB |
| 再讀一個 context                   |         0.33 ms |             0.80 ms |              1.36 ms |
| 開全部 101 session／shared storage |        71.78 ms |            60.56 ms |              2.07 ms |
| 開啟後 heap 增量                   |       74.74 MiB |           10.84 MiB |             0.10 MiB |
| 逐個讀全部 101 context             |         5.61 ms |            12.09 ms |             62.15 ms |

SDK 的一個檔案是 parent（300 則）；durable 也讀 parent。全部 context 逐個讀後只保留 count；SDK managers 本來就保留 parsed entries，而 SQLite 沒有被測試程式強制保留全部 context，所以小 heap **不是「101 個活躍模型都不佔記憶體」**。

另記錄 fork＋append＋context-count assertions 的單次耗時：SDK 452 ms、durable JSONL 98 ms、SQLite 166 ms。SDK 每 message append，durable 同 child 的 40 entries 一個 commit，且 SDK 需 reopen parent 建獨立 handle；**不能拿這欄宣稱 backend 的 apples-to-apples write throughput**。

**解讀**：

- 只活躍一個 session 時，SDK JSONL 已很輕。舊「durable JSONL 開 2,000 threads 要 1 秒、SQLite 1 ms」不能套成相對於以前每 session JSONL 的 1,000 倍升級收益。
- 100 個 thread 都繼承相同父歷史時，SDK 每 fork 複製 300 則，所以大小增長；reference fork 明顯省重複內容。這個收益同樣在 durable JSONL 出現，**不是 SQLite 的功勞**。
- SQLite open／lazy memory 表現很好，但逐個 decode 所有 context 有查詢成本；JSONL preload 後連續讀反而快。
- 在這組資料，SQLite 比 durable JSONL **大約 1.9 倍**。索引、pages、record layout 的成本不能忽略。資料量／payload shape 改變，比例也會變。
- 這是 1.0.0 storage 與 1.0.2 SDK 的有限 POC，不是 production 1.0.2 全 runtime benchmark；新增 ProviderDoc、真實模型／tools／compaction、runner cap 等需要另測。

### 7.3 先前數字應怎麼引用

[舊研究](thread-session-origin-2026-10.md) 的 2,000 threads 結果，是同一個 durable shared storage 的兩種 backend；它確實支持 shared storage 選 SQLite，但**沒有比較正式 SDK 一個 session 一個檔案**。同份舊研究自己的表格也顯示 SQLite 大於 JSONL。

交接中的某 office：舊 v4 約 17.82 MiB、新 DB 約 13.07 MiB。遷移只匯入 visible context，未把全部舊 raw history 原樣搬入；差 27% 不是公平 backend compression 效果。原檔保留，也不代表全部舊歷史已在新 DB 裡。[M6]

先前模型回答的少量 QA trials 說明「保留真實工具 context」優於只塞 Slack 回答文字，但不證明只有 durable 才能做到，也不建立普遍的模型準確率提升。SDK POC 已驗證保留相同父 context 可行。

## 8. 選項比較與建議

| 選項                                             | 優點                                                                              | 代價／未驗證                                                                                                    | 判斷                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 維持 durable＋shared SQLite                      | 已部署、真 reference fork、lazy reads、committed state、native recovery substrate | Experimental API、共享 lifetime／routing 接縫、人工查看成本、office-wide failure domain；recovery目前不自動使用 | **當下最小操作風險**；是否長期保留取決於實際 reference-fork／recovery 需求 |
| 正式 coding-agent SDK＋每 session JSONL          | 跟日常 CLI 相同機制，public compaction／retry／fork／operations；容易人工檢查     | fork重複歷史；正式 SDK policy/resource/model integration 不是零成本；新資料 importer／全契約驗證                | **優先研究替代方向**，不因「CLI」排除，但尚不批准切 production             |
| durable＋每 session JSONL                        | 仍由 durable 管 task，檔案可讀、較小 failure domain                               | 仍是 main＋sidecars 的多檔 durable 格式，不是 SDK 一行一訊息；fork跨 storage需copy；沒有消除 framework成本      | 不符合「不要 durable execution framework」的訴求，不當首選退路             |
| core Agent＋mikan persistence／compaction policy | runtime API 少、最大控制                                                          | mikan 接手重試／摘要／journal／中斷處理；若再加 scheduler／checkpoint 就自建 framework                          | **不優先**；除非決定明確放棄那些產品保證                                   |
| SDK＋自行 bridge 現有 SQLite                     | 可能保留 backend                                                                  | SDK未提供 drop-in通用storage seam；容易造出第二套 persistence layer                                             | 沒有 POC 前不列為「兩全其美」                                              |
| 長期停留舊 0.99 harness                          | 避免現在搬資料                                                                    | 上游已移除該子系統；錯過修正／provider演進                                                                      | 可當短期 rollback 工具，不是跟進 Pi 的長期方案                             |

**我的建議不是立刻撤回，而是重新把選擇條件寫清楚：**

- 若「跟著 Pi」是指 **跟正式 coding-agent 的日常行為**，SDK 的對齊最直接，本輪已證明不能把它視為不可用。
- 若最看重 **大量 thread 共享完整上下文而不複製**，現有 durable＋SQLite 有具體優勢；但要用真實 context bytes、fork rates、active runner cap 量測，而不是拿假設 2,000 sessions 給所有頻道背書。
- 若 **部署後必須恢復未完成的工作** 是產品需求，durable 是合理 substrate；先設計 responder重接／effect safety，不要把 README功能當已交付。
- 如果這些額外需求都不成立，不能只以「官方 successor」或「少維護自己程式」合理化對 scheduler／documents 的依賴。

ADR 0017 對 SDK 的排除理由不足；ADR 0018 對 shared durable JSONL vs SQLite 的比較有實證，但沒有完成 SDK topology 的比較。這不等於當時部署錯誤：舊 experimental harness 確實消失，資料與工具整合確實需要替代；只是長期選擇仍需補足證據。

## 9. 切換前不能跳過的驗證

1. **版本對齊**：用精確 deployment package versions 重跑現有契約；區分 mikan session identity 與 native provider identity。
2. **SDK 對照 adapter**：以目前 runner 對外契約驗證 cancellation during auth／tool／retry／compaction、steer／stop races、每 session model／budget／usage、codemode／MCP grants、secret redaction。維持 injection，不帶入 host預設工具／自動資源發現。
3. **真實安全 sandbox**：驗證所有四個 tool operations、超時／abort、large output、image read、路徑 namespace／mutation serialization、private office／Vault mount；本輪只做 virtual read，不算安全證明。
4. **restart policies**：明確決定 SDK 路線的 interrupted tool call／dangling result mapping、queued input 的命運；不複製 durable scheduler 來假裝等價。
5. **migration rehearsal**：只能從安全快照用 public readers 匯出 settled context／bookkeeping；涵蓋 reset、compaction、fork parent、run cause、工具call-result配對、system/tool declarations、session key、name與sync cursor。SDK fork會複製祖先歷史，需要量測匯出空間。重新比較每 session model-visible context。
6. **保留新資料**：舊 `sessions-v4/` 備份不含 durable部署以後的新對話，直接退回 old files 會丟新資料。SQLite不能重命名為 SDK JSONL就當遷移成功。
7. **運行對照**：同payload量測一個／多個活躍thread的RSS、imports／open／context latency、serialized bytes、實際provider cache、compaction spend；與相同context語義對比。
8. **人類批准後才做平台／deployment E2E**。本輪沒有做，也沒有宣稱選定路線已可上 production。

## 10. 驗證紀錄與仍未知事項

- 本輪 offline POC 所有 context-count、fork isolation、headless tool loop、provider session-ID assertions 通過。為保持工作目錄乾淨，腳本自動刪除自己的 synthetic datasets；保留腳本以重跑。
- mikan 本地 `office-sessions`、`harness-cancellation`、`chat-history-sync`：**3 files／43 tests 通過**，seed `1791175720088`，基於 installed 1.0.0 dependencies，不是 1.0.2 production E2E。
- 新文件與 POC 的格式檢查通過；`doc-references.test.ts` **3 tests 通過**，seed `1791176395933`。
- 未解答：正式 SDK 是否有已承諾的 durable遷移計畫；精確 production版本的 cache／budget同時工作表現；完整SDK adapter的安全與cost；目前recovery的產品需求是否值得額外runtime；長期office DB增長／保留策略。
- 本研究 **不建立任何 production failure、使用者資料損失或立即撤回的結論**。它修正原先比較不完整與版本混用的問題。

## 11. 獲批後的本地精簡

### 選擇與實作

- 四個 direct dependencies：Chord、pi-agent-core、pi-ai、pi-durable 精確固定為 **1.0.2**；使用 `npm install --ignore-scripts --save-exact`。pi-codemode／pi-mcp 保持 1.0.0，不改它們的 direct ranges。必要 transitive 更新為 pi-telemetry 1.0.2、Anthropic SDK 0.129.0。
- Runner binding 從公開 `ProviderDoc` 讀取 provider identity；只有缺少 document 的舊 conversation 才透過公開 transaction 初始化。不是 mikan 自造另一個 UUID／provider document。
- 一個既有 bindings map 同時持有 runner binding 與 native identity。Generation／compaction 的 `options.sessionId` 尋找對應 binding；未知 identity 直接拒絕，不借用最新 runner。
- 移除 `tagRequest`、message-object copy／WeakMap owner index，以及補入 mikan session ID 的 `withSession`。
- 共享 exported binding types 移到 sessions/types.ts。預算、provider transport admission tracking、授權／sandbox、未完成 task 的 abort policy 均保留；SQLite 路徑和 mikan session-index IDs 不變，不新增資料格式遷移。

| 選擇                                         | 替代方案                     | 理由／代價                                                                                    |
| -------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| 對既有 bindings 做 native identity lookup    | 再維護一個 provider-ID index | 少一個需同步與清理的索引；每 request 為 O(active bindings)，不是 O(office 歷史 conversations) |
| 缺少 ProviderDoc 時用公開 transaction 初始化 | 等第一個模型請求才生成 ID    | Request 到來前就能綁定 owner；已存在的 identity 不重寫，缺少時只 backfill 一次                |
| Native identity 不匹配就拒絕                 | 回退 latest binding          | 不讓請求落到另一 runner 的 models／budget；這是刻意收緊的行為                                 |

| 對照                                         | Before                             | After                                   |
| -------------------------------------------- | ---------------------------------- | --------------------------------------- |
| Request owner                                | 最後 message 的 JS object identity | Pi 持久化 provider sessionId            |
| Routing state                                | bindings Map＋owners WeakMap       | 一個 bindings Map                       |
| mikan 每 request 的 context tagging          | 複製最後 message 和 messages array | 無；Pi 本身的 copies 不在此計數         |
| Compaction owner                             | 無 tag，落到最新 binding           | Native identity 選自己的 binding        |
| 三個改動 production 檔案的 physical LOC 合計 | 基準 fe168bcf                      | 淨變化 0；不把搬移 types 當成減少複雜度 |

### 驗證與量測

可重跑 [native-routing POC](../../scripts/experiments/pi-provider-routing.mjs)：真正建立暫存 SQLite、兩個 conversation／分別的 faux model catalogs，透過公開 APIs 執行 generation 和 manual compaction，並驗證 fork identity 不同、reset 保持 identity、重開後 identity 持久化。只用 synthetic context／faux providers，不呼叫付費模型。

Routing microbenchmark：340 messages、12 active bindings、100,000 iterations，Node 24.14.1；舊 object-tag＋WeakMap 路由約 **53.8 ms**，native bindings lookup 約 **7.0 ms**。單次測量、非 production latency、非整個 Harness 或 LLM 的加速倍數；不包含 binding snapshot／首次 backfill commit。優先理由是移除私有 identity 假設與 owner index，不是這個微小耗時。

- 新增兩個 public-interface 回歸測試：複製 message objects 後，兩個 model catalogs 和 compaction 仍走自己的 owner；缺少 ProviderDoc 的 conversation 在 binding 時 backfill，reset／完整關閉重開後保持 ID。
- 將同樣五個 office-sessions 測試放到 **fe168bcf 獨立 worktree**，共用精確相同的 1.0.2 dependencies：舊 implementation **2 failed／3 passed**，新 implementation **5 passed**。這排除「只是升版本／改期望值讓測試通過」的解釋。
- 本地全套：**149 files passed；2,043 tests passed、1 skipped**，seed `1791180650301`；包含 source guards、migrations、harness／MCP／sandbox／budget／cancellation／steering 與 doc references。不是 production E2E。
- Lint、全專案 typecheck 通過；新增 POC 與修改檔案按專案 formatter 處理。

### 尚未完成的交付與風險

此階段本地 Node **24.14.1 低於 mikan 要求的 24.15.0**，npm 有 engine warning；當時未取得 Node 升級批准，因此沒有把測試當成 supported-runtime 驗證。後續獲批升級與 supported-runtime 重驗見第 12 節。npm audit 回報 21 項（6 moderate、14 high、1 critical），本輪未分析歸因，也未跑 audit fix 擴大依賴變更。

未 commit、push、平台 E2E 或部署。仍保留 per-provider budget／onPayload adapter、Harness-wide settings 和 model metadata 的 latest-binding policy、compaction wrapper text 的小型例外；沒有宣稱所有接縫都可刪除。若從 durable 1.0.0 升級，provider identity 會改為 Pi 的 UUID，不能把它當作 mikan session ID；已在 1.0.2 存在的 ProviderDoc 保留，不做重寫。

## 12. 獲批升級本機 Node 與重驗

使用者另行批准升級本機 Node。透過既有 nvm 從 nodejs.org 下載 **24.21.0**，nvm 的 SHA-256 checksum 校驗通過；維持 default alias `24`，不跨大版本。新 shell 實測 Node 24.21.0、npm 11.19.0、Pi 1.0.2，符合 mikan 的 Node >=24.15.0 要求。官方版本來源：[Node 24.21.0 archive](https://nodejs.org/en/download/archive/v24.21.0)。

- 保留 Node 24.14.1。既有全域 CLI／packages 以連結保留原套件版本，沒有重新安裝或執行額外 lifecycle scripts；npm 11.19.0／corepack 0.36.0 是新 Node 的 bundled versions。
- 這些保留的 global package links 仍依賴舊版本目錄；日後移除舊 Node 前需先搬移全域套件。`tiny-ts` 原本的 build target 就不存在，僅保留原入口，沒有越界建置另一個 repo。
- 新 shell 使用新版；現有 shell 可執行 `nvm use default`，已啟動的 Pi process 需重啟才更換它的 Node runtime。本輪沒有重啟正在服務的 process。
- 在 **Node 24.21.0** 重跑 lint、全專案 typecheck、native-routing POC，全部通過；全套 **149 files／2,043 tests passed、1 skipped**，seed `1791184870074`。
- 不改 production、不做平台 E2E、不 commit／push。第 7／11 節舊 microbenchmark 保留原 Node 版本與原數字，不因升級冒充新環境重測結果。

## 來源

上游原始碼引用固定 **v1.0.2**，不是漂移的 main；mikan 本輪 source 固定於首節 commit。官方網頁 L1 是研究當時的 live 文件，未當版本固定規格。

- **[P1]** 正式 [coding-agent package](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/package.json)、[sdk.ts](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/sdk.ts)，`createAgentSession`／`new Agent`；[官方 release](https://github.com/earendil-works/pi/releases/tag/v1.0.2)，tag／releases API交叉核對。
- **[P2]** [experimental durable TUI README](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/experimental/durable/README.md)；[建立commit](https://github.com/earendil-works/pi/commit/5609b0d6c07cd3bf8014429123086f6da0a5e14e)。
- **[P3]** [experimental services README](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/experimental/services/README.md)；[port commit](https://github.com/earendil-works/pi/commit/48dd1e2f0f9dc7a767d7e5ee693bc85a4d6db38c)。
- **[P4]** [移除 experimental harness commit](https://github.com/earendil-works/pi/commit/7fd478a2e888ebc28869566f33a186303d372838)、[core changelog](https://github.com/earendil-works/pi/blob/v1.0.2/packages/agent/CHANGELOG.md)、[core README](https://github.com/earendil-works/pi/blob/v1.0.2/packages/agent/README.md)。
- **[P5]** [durable README](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/README.md)、[spec](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/docs/spec.md)，§2 conversations／Harness、§4 commits、§5 effect sandwich／scheduler、§8 generation／tool／compaction、§11 backends／§13 non-goals；[package](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/package.json)；[implementation handoff](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/docs/pico-v5-handoff.md)、[Chord guide](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/docs/pico-v5-chord-usage.md)。
- **[P6]** [SDK docs](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/sdk.md)、[full-control example](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/examples/sdk/12-full-control.ts)、[read operations](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/tools/read.ts)、[bash operations](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/tools/bash.ts)、[public exports](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/index.ts)、[SDK session runtime example](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/examples/sdk/13-session-runtime.ts)。
- **[P7]** [SessionManager](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/session-manager.ts)，`_persist`／`createBranchedSession`／`buildSessionContext`／`forkFrom`；[session format](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/session-format.md)、[sessions](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/sessions.md)。
- **[P8]** [AgentSession](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/agent-session.ts)，`_handleAgentEvent`／retry／abort／steer；[compaction reference](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/compaction.md)、[how Pi works](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/how-pi-works.md)、[settings](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/settings.md)、[message types](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/message-types.md)。
- **[P9]** [native provider identity fix](https://github.com/earendil-works/pi/commit/70eceaade630d348aa42ca3e4ff3b785dad80754)，已確認包含於 v1.0.2；[ProviderDoc](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/provider.ts)、[generation](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/generation.ts)、[compaction](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/compaction.ts)。
- **[L1]** LangGraph 第一方 [Functional API](https://docs.langchain.com/oss/python/langgraph/functional-api)、[durable execution／persistence](https://docs.langchain.com/oss/javascript/langgraph/durable-execution)，web_search查閱，僅比較durable問題域，不主張兩套runtime等價。
- **[M1]** [遷移前 SessionStore](https://github.com/geminixiang/mikan/blob/c1a1741a545ed8a5ccaaea395a111412cb705da2/src/sessions/session-store.ts)；[舊遷移研究](pi-agent-core-1-migration-2026-10.md)。
- **[M2]** [SessionStore](../../src/sessions/session-store.ts)，`OfficeStorage`／`abortUnfinishedWork`／`tag`／`forkRun`；[sessions README](../../src/sessions/README.md)。
- **[M3]** [MikanAgentSession](../../src/harness/session.ts)、[harness README](../../src/harness/README.md)、[subagent](../../src/harness/subagent.ts)、[tool adapters](../../src/harness/tools/pi-tools.ts)。
- **[M4]** [office-sessions tests](../../src/test/office-sessions.test.ts)、[summary recognition](../../src/sessions/compaction-summary.ts)。
- **[M5]** [package.json](../../package.json)、[ADR 0017](../adr/0017-pi-durable-harness.md)、[ADR 0018](../adr/0018-one-durable-storage-per-office.md)。
- **[M6]** [SQLite migration](../../src/migrations/sessions-sqlite.ts)、[v4 reader](../../src/migrations/session-v4.ts)、[migrations README](../../src/migrations/README.md)、[thread origin research](thread-session-origin-2026-10.md)。
- **[E1]** [初次可重跑 POC](../../scripts/experiments/pi-runtime-research.mjs)；§7列實測版本、資料形狀、取樣與限制。
- **[E2]** [獲批後 native identity POC](../../scripts/experiments/pi-provider-routing.mjs)；§11 列新版本、before/after negative control、驗證與限制。
