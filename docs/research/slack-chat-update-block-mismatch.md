# Production Slack `chat.update` / `block_mismatch` 研究

## 摘要與決策狀態

**結論：已確認 Slack 拒絕訊息替換、mikan 失敗更新的節流缺口會放大錯誤；尚未確認 Slack 判斷 rich/non-rich 替換的確切觸發條件。** 不應將「heading/table 導致 server-side block shape 改變」這個有依據的候選解釋，寫成已重現的根因。

團隊建議分兩條工作線，均須後續批准才實作：

1. **先處理使用者交付風險與放大效應**：以嘗試時間節流、對同一 target 的 mismatch 採有界退避／低頻探測；終稿更新明確失敗時，才考慮一次有界新訊息 fallback，保留舊訊息、正確追蹤新 ID／thread，並明確處理 fallback 失敗與未知結果。這是 containment，不是消除首次拒絕的 root fix，也不是 exactly-once 保證。
2. **另取得隔離 Slack test channel 的外部寫入授權**，用 synthetic 內容建立 transition matrix；比較 `blocks: markdown`、`markdown_text`、穩定 `rich_text`，再決定最小的 rendering/lifecycle 根因修復。沒有這一步，不推薦直接重寫 renderer 或下注固定前綴。

僅降低／隱藏 Sentry 事件不算修復。本次沒有改 production、發送／更新／刪除 Slack 訊息、restart、修復實作、commit 或部署。

## 範圍、方法與證據等級

- **[E] 既有 production 實證**：本任務交接提供的 Sentry API／Slack history 唯讀調查結果。本團隊不把它冒充本次重新查詢的數值；相對「近 7 天」統計的精確查詢起訖未附在交接，不能當永久固定時間窗。
- **[C] 官方契約**：Quartz 本次以已授權 browser 唯讀檢查 Slack 官方 reference；來源見下表。
- **[L] 本地程式／測試**：Birch 獨立追蹤 lifecycle、Cedar 交叉閱讀核心程式。本地 `HEAD=880b7ab`，package `1.0.0-beta.58`；`git describe` 為 `1.0.0-beta.57-4-g880b7ab`。交接稱 production beta.58、CLI PR #146 已 merge 未部署。上述標記不是部署 artifact hash 的證明。
- **[H] 推論／待驗**：只能排序研究方向，不能聲稱已用 Slack live reproduction 驗證。

本任務限制外部唯讀，**沒有可對 Slack 真實 replacement 行為跑紅／跑綠的重現命令**。既有 injected-error tests 不滿足 root reproduction。因此本報告是 evidence review、風險分析與條件式建議，並非完成 diagnosis → fix → regression 的宣告。無額外擷取私人訊息正文或 credentials；本文只保留 raw operational IDs 與結構資料。

## 1. Production 症狀與使用者影響

### 1.1 數量：errors 不等於答案或使用者

[E] Sentry org `gliacloud-z3`，project `pi-agent`（`4511194501808128`），issue `7648747302` / `PI-AGENT-1P`，標題 `WebAPIPlatformError: An API error occurred: block_mismatch`，firstSeen `2026-08-03T02:33:55Z`。既有查詢 cumulative count 為 **4119**；Discover `issue.id:7648747302 environment:production` 近 7 天查得 **1419 errors / 9 channel IDs**。

| channel ID  | errors |
| ----------- | -----: |
| D0B0QQAE50W |    934 |
| C0BH4F056DQ |    228 |
| D0AMUR4566L |    165 |
| D0AKS5AHX89 |     42 |
| C043FHB0RK4 |     25 |
| C0B1EGP9TGS |      8 |
| D0ALXDH4RGQ |      8 |
| D0APVHGH2F8 |      8 |
| C0BKLRG3RLH |      1 |

不能說是 1419 個失敗 run、9 位使用者或 4119 個遺失答案。DM 與 channel 混合；尚無總 run／更新量分母，無法算受影響比例。tag-values endpoint 有忽略 `statsPeriod`、回傳 8 月資料的跡象，故不能用其結果替代 Discover 統計。

### 1.2 四個 representative targets

以下全為 [E]；UTC。`sourceLength`、table dimensions 是拒絕當下送出的 payload metadata；canonical blocks 是**後來 history 快照**，不是失敗前狀態。

| target / event                                                                | rejection window / 次數        | 失敗 payload                                                   | 事後 recovery 與 canonical 快照                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `C0BH4F056DQ` / `1789347600.231649`; event `6375395a1da84382b9270108ca9adb0b` | 09-14 01:03:52.525–54.322 / 9  | single markdown、leading heading、sourceLength 6–27；scheduled | recovered 01:03:54；textLength 884、edited `1789347840`；rich_text/header/rich_text/table/rich_text |
| `C043FHB0RK4` / `1789297200.380679`; event `fbeb277ab03d45bfbf5e22cb9d28e1b5` | 09-13 11:01:47.596–50.517 / 8  | single markdown、leading heading、sourceLength 6–19；scheduled | recovered 11:01:50；textLength 1682、edited `1789297350`；含 rich_text/header/table                 |
| `D0B0QQAE50W` / `1789114277.652489`; event `5f55ce9074084ba199847a5069772331` | 09-11 08:12:30.522–34.311 / 16 | single markdown、leading heading、sourceLength 6–44；普通 DM   | recovered 08:12:35；textLength 2852、edited `1789114371`；rich_text/header/table/rich_text          |
| `D0AMUR4566L` / `1789039236.725179`; event `63e66ea229164145aa4efda0427d5184` | 09-10 11:20:47–11:21:26 / 165  | 後段 single table，7–9 rows × 5 columns，sourceLength 272–367  | recovered 11:21:26；textLength 342、edited `1789039288`；rich_text/table/rich_text                  |

這四個 target 均有後續成功更新；未逐字比對最終答案，不足以保證完整送達，更不能外推所有 targets 都恢復。約 1.8 / 2.9 / 4.8 / 39 秒是 rejection-to-success lag，不是總延遲或 time-to-answer；recovery timestamp 粒度與事件時間不同，不宜做更精確推算。

### 1.3 能說與不能說的影響

- **已觀察**：同 target 可連續被拒，間隔約 0.22–0.25 秒；短暫與約 39 秒的失敗區間均存在。四樣本後來有成功更新。
- **合理風險**：[L] 失敗 update 無法完成該次新內容交付，因此進度可能停在舊／partial 內容；若 final update 也失敗，程式可能不執行 `onFinish` 且讓外層 promise resolve。這是程式可達風險，不是已證明 production 遺失最終答案。
- **未知**：distinct affected runs、最終失敗數、使用者實際看到的畫面、答案完整性、整體受影響率、各 lifecycle 路徑占比。Slack canonical history 不是 desktop rendering 證據。

[L] `update-diagnostics.ts` 的 recovery 只表示同 owner process 中同 `channel:ts` 曾 error 後一次 update success：WeakMap 暫存最多 128 targets、按最後 failure 時間保留 10 分鐘、success 後刪除，不跨 restart。`failedAttempts` 是跨更新累計的 diagnostic counter，不是 retry loop 或 run 數。沒有 recovered 不代表永久未恢復，有 recovered 也不代表 final 已交付。不可把同 process 的無關 breadcrumbs 配到當前 channel。

## 2. 官方契約與不能延伸的部分

| 來源                                                                                              | 本次確認的契約                                                                                                                                                   | 不足以證明                                                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [S1 markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/#usage-info) | server translation：`passing a single block may result in multiple blocks after translation`；`block_id` ignored / not retained；列 heading、divider、table 支援 | 未承諾精確 canonical types、位置匹配演算法或任意形狀 update 相容                                         |
| [S2 chat.update](https://docs.slack.dev/reference/methods/chat.update/#errors)                    | `block_mismatch`: `Rich-text blocks cannot be replaced with non-rich-text blocks`；`streaming_state_conflict` 是 currently streaming、cannot edit 的另一錯誤     | 不可單靠 error 文案認定 heading 的哪個位置觸發、所有 markdown update 不合法，或 native stream 是唯一前因 |
| [S2 chat.update arguments](https://docs.slack.dev/reference/methods/chat.update/)                 | 支援 `markdown_text`，不能與 `blocks` / `text` 混用，12k limit；text-only 而不給 blocks 會移除舊 blocks                                                          | `markdown_text` 或 text-only 不是已知繞過 mismatch 的保證                                                |
| [S3 chat.stopStream](https://docs.slack.dev/reference/methods/chat.stopStream/)                   | `blocks` rendered at bottom of finalized message；stream `markdown_text` / chunks modes 不可混用                                                                 | stopStream(full final blocks) 不等於替換；可能重複已有內容，且不涵蓋 buffered 路徑                       |
| [S4 table block](https://docs.slack.dev/reference/block-kit/blocks/table-block/)                  | 支援 postMessage blocks/attachments；100 rows × 20 cells、aggregate 10k characters                                                                               | 沒有 rich→table update 豁免；不能因失敗樣本有 table 就認定尺寸超限                                       |
| [S5 rich_text](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/)                | rich_text 是官方推薦表達格式之一；table/rich_text 的 block ID 指引要求每次 update 用新 ID                                                                        | 不保證 mixed header/table 既有訊息轉換安全；固定 block_id 不是修復                                       |

歷史第一方公告：[markdown](https://docs.slack.dev/changelog/2025/02/03/block-kit-markdown)、[table](https://docs.slack.dev/changelog/2025/08/14/block-kit-table-block)、[streaming](https://docs.slack.dev/changelog/2025/10/7/chat-streaming)。本次研究未發現針對本錯誤的已知 bug/fix 公告；「沒找到」不代表不存在。

[本 repo ADR 0001](../adr/0001-slack-native-markdown-blocks.md) 記載 2026-07-24 live 驗證 markdown 被 postMessage / update 接受並轉 rich_text。這是歷史工程實驗記錄，不是當前 Slack 行為重現，但足以反對「markdown 從來不能 chat.update」的概括。ADR 的 table 支援敘述與目前官方 S1 有時間差；實際程式仍自己 extract tables，不能僅憑新文件刪除此行為。

## 3. 本地機制：首次拒絕、放大與交付是不同問題

主要程式來源（本地 HEAD；行號只作定位）：

- [`bot.ts`](../../src/adapters/slack/bot.ts):558–570：`resolveMentions → renderSlackBlocks → slackRetry(chat.update)`，record rejection 後 rethrow。`slackRetry` 的已知 retry 條件是 rate limit，不是 `block_mismatch`。
- [`blocks.ts`](../../src/adapters/slack/blocks.ts)：prose 交由 native markdown、table 由本地 parser 擷取為獨立 table block。來源文字增長會改變送出 block 組合；單一 markdown 也可被 Slack 展開為多 blocks [S1]。
- [`response-lifecycle.ts`](../../src/adapters/slack/response-lifecycle.ts):101–103、302–325 與 [`progressive-renderer.ts`](../../src/adapters/progressive-renderer.ts):213–215、252–278：非所有回應皆 native stream；已有 `initialResponseId` 可直接 edit，成功 stop stream 後含 table 才需要 canonical render。
- `bot.ts`:874–899、[`session.ts`](../../src/adapters/slack/session.ts):70–84：scheduled event 先發 anchor，再將 initial response ID 帶進 lifecycle。因此 scheduled 與普通 DM 都可經 update；不能把問題限縮成 streaming final edit。
- [`progressive-renderer.ts`](../../src/adapters/progressive-renderer.ts):282–302：單 renderer queue 序列化；`run()` catch 記錄錯誤後 resolve，Slack 沒有 `notifySendFailure`。
- 同檔 305–327：`lastFlushAt` 只在 render 成功後前進；失敗後後續 delta 可再次滿足 elapsed 條件、每個 delta 打 update。這是已確定的本地放大機制，與 production 拒絕密度一致，**不是首次 mismatch 的原因**。
- 同檔 354–369：`renderFinal` reject 會跳過後續 `onFinish`，而 `run` 消化 rejection。正常外層完成不等於 Slack final delivery 已確認。
- [`update-diagnostics.ts`](../../src/adapters/slack/update-diagnostics.ts):4–7、111–139：上述暫存／recovery 語意。

Birch 比對 beta.58 bump `9e6af08` 與 HEAD `880b7ab` 的五個核心檔（bot、blocks、response-lifecycle、progressive-renderer、update-diagnostics）無 diff。這縮小 CLI merge 的相關性，但**尚未唯讀核對 VM 的實際 deployed source/hash**，不能宣稱完整 binary 等價。

## 4. Root issue：已證層級與未驗證研究問題

### 已證層級

1. [E+C] Slack 回傳已文件化的 rich-text → non-rich-text replacement restriction；這是直接拒絕原因的 API 分類。
2. [L+C] mikan 對同一 message ts 反覆提交會隨內容增長而變化的 markdown/table payload，且 Slack 有 server expansion。mikan 沒有在此路徑保證 replacement shape 相容。
3. [L] 首次失敗後的更新頻率與 final delivery failure handling 有缺口；兩者應各自修正，不應混成 Slack trigger 的證明。

### 待授權實驗的可否證問題（不是已完成因果診斷）

| 問題／候選解釋                                                      | 支持與限制                                                                                           | 區分方式                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| H1：舊 rich_text 與新 heading/table 展開後的 block shape 不相容     | 三 heading、一 table 樣本與 S1/S2 相符；缺 before canonical，無法知道匹配規則                        | 相同 payload 在新 post 合法、對特定 canonical old state update 才失敗；改為 paragraph / rich_text 對照 |
| H2：anchor / 先前 progress 建立不同 old state，導致某些路徑易受影響 | scheduled anchor 與 buffered 源碼可達；不能直接當 rich_text 前態實證                                 | 同一 payload 分別更新 plain anchor、markdown paragraph、rich_text、stopped stream，逐步抓 before/after |
| H3：native stream 停止時序或 state 邊界參與部分案例                 | stream 與 canonical edit 確實有生命週期；但 S2 有另一 streaming_state_conflict，且 buffered 也受影響 | 區分 active/stopped stream 與非 stream；若只有 stream 失敗才支持窄化，不足以解釋全體                   |
| H4：payload 限制／SDK 或 Slack 特定 parser 行為                     | table/markdown 有限額，但小 heading 與目前 error code 不支持單純尺寸解釋                             | 固定短合法 payload、記錄 API error 類型，對比 post/update；再獨立變更尺寸，不混變數                    |

不把固定 block 位置、placeholder、working suffix、block_id、Slack service bug 或並行 writer 寫成既定根因。單 renderer queue 序列化不能排除其他 process／writer，但目前沒有其正面證據。

## 5. 多解法比較與團隊相互質疑

| 方案                                                                      | 能解決什麼                                                  | 代價／反例                                                                                                                  | 判斷                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A. 以 last-attempt 時間節流＋mismatch 有界退避／低頻探測                  | 降低每 delta rejection；讓可自癒 target 有恢復機會          | 不消除第一次 mismatch，不保證 final；完全停更會犧牲目前 1.8 秒便恢復的 progress                                             | **近期必要 containment**，非單獨答案                                |
| B. final update 明確 mismatch 後，一次 bounded 新 post；保留舊訊息        | 避開對既有 ts 的替換前態，涵蓋 anchor/buffered/stream final | 舊 partial＋新 final 可能重複、通知增加；新 post 也可失敗或 timeout；需 ID/thread/session routing、一致終止、未知結果處理   | **條件式首選 delivery containment**，與 A 配套，不聲稱 exactly-once |
| C. 全生命週期穩定 rich_text                                               | 對 rich/non-rich restriction 的契約理由較強                 | 不能保證已存在 mixed/header/table target 可遷移；table 降級、escaping/mention/list fidelity 與維護成本；ADR 曾估 300–400 行 | 授權實驗候選；未證明前不重寫完整 renderer                           |
| D. 改用 chat.update `markdown_text`                                       | API 現有入口，可能比 renderer rewrite 小                    | 同樣可能翻譯並遇 replacement constraint；12k、與 text/blocks 互斥；native table 與長訊息策略要重新驗證                      | **優先低成本實驗**，非已知修復                                      |
| E. provisional 用 section/plain rich_text，final 才 native markdown/table | 中間 shape 較穩定、保留 final formatting                    | 把不相容轉換推到最重要的 final；plain text-only 會移除 blocks，也沒有安全保證                                               | 不能單獨推薦                                                        |
| F. stream stop 後不 canonical edit，table 另發新訊息                      | 可縮減 stream→edit surface                                  | 未涵蓋 anchor/buffered/replace；stopStream blocks 是追加非替換，full final 會重複；多訊息路由複雜                           | 只有產品接受分訊息時再評估                                          |
| G. 固定 rich_text 前綴／block_id／刪除重發／只遮蔽告警                    | 可能降低表面症狀                                            | markdown 不保留 block_id；prefix 依賴未知位置演算法；delete 破壞既有訊息／thread；遮蔽無交付改善                            | 不採為預設修復                                                      |

### Team 討論紀錄

- **Birch → root hypothesis**：scheduled anchor 也走 edit，反駁「全是 native stream 問題」；把 retry pacing 與首次拒絕拆開；final catch 可能吞掉 delivery failure。
- **Quartz → renderer rewrite**：rich_text 官方推薦不等於 mixed target update 安全；`markdown_text` 有官方入口但沒有修復證據；反對以 fixed block_id 當 fix。
- **Cedar → 首選 containment**：若第一次 mismatch 就完全停止 target 更新，會讓原本快速恢復案例失去進度；fallback post 未知結果可能產生 duplicates。要求採 bounded probing，明確把 final success、definite failure、unknown outcome 分開，而不是泛稱「保證交付」。
- **Birch → fallback 路由反例，Quartz 接受**：scheduled 原 response ts 同時是 session/root anchor；更換 visible response ID 不等於可更換既有 thread/session identity。診斷、continuations 與 final 必須保持清楚的原 root lineage，否則可能把同一工作分岔到不同 threads。
- **共同限制**：bounded fallback 不能放在一般 delta path 自動重複發文，不能假設新 message ID 可不更新 lifecycle，也不能為清理 partial 默認刪除舊訊息。所有 implementation 需另行批准。Cedar 留下初稿後因 agent timeout 退出；Birch 接任 reporter、完成補充，Quartz 獨立審閱，未把退出當作對新增內容投票。

## 6. 後續驗證計畫與驗收標準（本次未執行）

### 6.1 需要的授權

請求單獨授權在**隔離 test channel** 以 synthetic 無私人正文內容執行 `chat.postMessage`、`chat.update`、`chat.startStream` / append / stop 與 history/replies read。限定次數、有界速率、預估訊息量與清理策略需事前同意；不在 production targets 實驗，不自行要求 delete。若無此授權，本研究停在目前因果解析度，不宣稱 root fix 已驗證。

### 6.2 最小 transition matrix

固定 app/token/channel，每步記錄安全 metadata，**先取得 before canonical，再提交 update，再讀 after canonical**：

- Initial state：plain-text anchor、markdown paragraph、explicit rich_text、已成功 stopStream 的 message。
- Next source：heading-only → heading＋paragraph；table-only → paragraph＋table；paragraph → heading/table。
- API encoding 對照：`blocks:[markdown]`、native table/mixed blocks、`markdown_text`、plain rich_text。
- 每一 payload 同時做 **new post 控制組**，區分 payload 合法與 replacement state；成功後再做同形 update，檢驗是否特定 transition 才失敗。
- Active stream 須獨立組，區分 `streaming_state_conflict`；prefix 與 block reorder 只在基本矩陣有結果後逐一改變，避免一次多變數。
- 記錄 error code、before/after block types/count、encoding、target/phase/attempt、API response status；不記 credentials、正文或人類可讀 identity。不可只看最後 history。

### 6.3 本地與交付測試門檻

本次 Birch 執行：

```sh
npm test -- src/test/progressive-renderer.test.ts src/test/slack-update-diagnostics.test.ts src/test/slack-blocks.test.ts
npm test -- src/test/slack-context.test.ts
```

兩次結果分別 **3 files / 45 tests pass**、**1 file / 63 tests pass**，合計 **4 files / 108 tests pass**。它們只驗本地 renderer/telemetry/lifecycle 行為，沒有 live root repro，也未加新測試或實作。

後續修復應另加以下 regression cases，再由授權 Slack matrix 驗原症狀：

1. mismatch 後大量 delta 不超過有界 attempt rate；source 持續累積而非遺失；稍後 compatible update 仍能恢復。
2. final 成功才記 delivered；final rejection 不被當作成功；`onFinish`／cleanup／回報各有明確語意。
3. fallback 只在明確策略下最多一次，不每 delta post；新 ID、原 thread root、scheduled session association 正確，舊 ts 保留。
4. post definite failure 與 timeout/unknown 分開處理；不得盲目 retry 造成重複，也不得未知時記 confirmed delivered。失敗可觀察且不只送 Sentry。
5. buffered、scheduled anchor、native stream、replace progress 均覆蓋；含 tables、長內容、mentions 的 readability/fidelity 另驗。

成效指標應是 distinct target/run 的 final delivery 狀態、rejection-to-success lag、update attempts/run、fallback 數量與 unknown/failed delivery，而不只 Sentry count。分母與 phase/run 關聯目前不足，若要新增觀測亦須另行批准；只保留結構 metadata。

## 最終建議

**建議使用者另行批准隔離 transition reproduction 與 containment 設計；現階段不建議未驗證的 renderer 大改。** A＋B 是團隊目前最小足夠的風險降低方向：節流修放大、bounded final fallback 處理已知替換失敗的交付出口；它不能替代根因實驗。D 是優先比較的小改候選，C 是驗證後仍必要才採用的較大選項。

實證所支持的說法是：「Slack replacement contract 與動態 rendered block shape 存在相容性風險，已造成 production 更新拒絕；mikan 的 error pacing/final delivery handling 放大其後果。」更細的『究竟何種 canonical block transition 觸發』仍待 live before/after 實验。不宣稱所有答案完整、所有 events 恢復或修復已完成。

## 追加唯讀調查：失敗與恢復 payload 對照

2026-09-14 由 requester agent 重新查詢 Sentry logs，按相同 `responseMessageId` 配對 recovery。數字欄位的實際名稱為 `tags[sourceLength,number]` 等；以裸欄位名查得 null 不代表資料不存在。Recovery structured logs 不含 array 欄位（blockTypes、markdownLengths、tableRows），因此不得由缺值推定 block types。

| responseMessageId | 已捕獲的拒絕 payload                                              | 首次 recovery payload                      | recovery 累計 failedAttempts |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------- |
| 1789347600.231649 | single markdown、heading、sourceLength 27（最後可見 error event） | heading、blockCount 1、sourceLength 30     | 10                           |
| 1789297200.380679 | single markdown、heading、sourceLength 19                         | heading、blockCount 1、sourceLength 21     | 8                            |
| 1789114277.652489 | single markdown、heading、sourceLength 44（最後可見 error event） | heading、blockCount 1、sourceLength 50     | 18                           |
| 1789039236.725179 | single table、table_like、sourceLength 367                        | table_like、blockCount 2、sourceLength 371 | 165                          |

最新 scheduled 樣本 recovery 的 precise timestamp 為 1789347834807943000 ns。部分 recovery counter 大於最後可見 error breadcrumb，表示目前捕獲的 error events 並不涵蓋每一次失敗，不能把前述9/16當作該段全部API失敗次數。

新證據縮小範圍：heading 樣本恢復時仍是 heading、且仍送1個block；因此「只要heading就失敗」與「必須增加送出block數才恢復」均不符合樣本。Table 樣本從1個block失敗到2個block恢復，值得針對後續新增prose的轉換驗證，但success logs沒有blockTypes，不能斷言第二個block必為markdown。

本地已執行 compiled `renderSlackBlocks` synthetic 對照：heading-only與heading+paragraph都產生1個markdown block；table-only產生1個table；table+paragraph產生table+markdown。這證明送出blockCount看不見heading內部的server expansion，不是Slack API成功/失敗重現。

依據仍不足以確定新增字元是否包含換行或段落，因content-free telemetry沒有正文或換行計數；也沒有失敗前canonical blocks。因此最小候選範圍是「heading/table區段尚未長出後續內容時的replacement，與長出後續內容後的恢復」，仍需隔離synthetic post/update授權才能驗證因果。未新增production instrumentation，未發送或修改Slack訊息。

## 本機實驗：實際 renderer 與注入失敗（2026-09-14）

執行 `npm run build` 後，以 `/tmp/mikan-local-mismatch.mjs` 匯入 compiled `renderSlackBlocks` 與 `createProgressiveRenderer`；執行 `node /tmp/mikan-local-mismatch.mjs`，全部本地 assertions 通過。腳本是本機暫存，不屬 production 或持久 regression suite；全程沒有 Slack request。

- 逐字送 synthetic heading＋正文，附上與 buffered 路徑相同的 ` ...`：送出類型一直是單一 markdown。不能從送出 blockCount 判斷 Slack 展開後結構。
- 逐字送 synthetic pipe table＋正文：markdown → table → table,markdown。進入 table 後，working suffix 起初落在表格區域；空行完成時 ` ...` 成為獨立 prose，尚未有正文文字即可產生第二個 markdown block。故「必須長出正文才恢復」仍過強，空行＋working indicator 也是待驗變數。
- 固定每100ms一個delta、共9個delta（首末間隔800ms）、預設1000ms節流：update全成功僅1次呼叫；注入每次block_mismatch則9次呼叫。驗證本地失敗節流缺口，非Slack首次拒絕條件。
- 先注入失敗再允許成功：累積source完整保留，成功時重新送全部文字；final成功時onFinish執行。
- 注入final update失敗：finishResponse仍resolve undefined，onFinish未執行，mock可見內容停在舊值。這證實本地delivery failure語意，不表示已證明production终稿遺失。

此實驗不能執行Slack server-side markdown translation，不能驗證 rich_text→header/table 的確切matching規則，也不能聲稱任何candidate fix已消除block_mismatch。Live synthetic transition仍需明確測試對話與外部寫入授權。

## Live 最小實驗（2026-09-14，local workspace）

使用者完成本地onboarding並授權嘗試後，以本地token auth.test確認team_id `T0B4DDYBVB3`，在DM `D0B4BL40DAN` 建立4則synthetic訊息；未啟動daemon、未使用production token、未修改既有訊息或刪除訊息。每次API間隔至少1300ms，每次update前後都查history。執行命令 `node /tmp/mikan-slack-minimal.mjs`；安全的合成結果 `/tmp/mikan-slack-minimal-results.json`（0600）。共4 posts、20 updates、40 history reads。

四則ts：heading blocks `1789361101.994949`、table blocks `1789361126.808569`、heading markdown_text `1789361151.574569`、table markdown_text `1789361176.377239`。

所有初始訊息由mikan renderSlackBlocks渲染普通段落，history確認為單一rich_text。同一訊息按以下順序更新；兩種API encoding得到相同結果：

| Before canonical | Next synthetic source                 | API result / after canonical    |
| ---------------- | ------------------------------------- | ------------------------------- |
| rich_text        | `# Synthetic heading ...`             | block_mismatch；舊rich_text不變 |
| rich_text        | heading + 空行 + ` ...`               | success → header,rich_text      |
| header,rich_text | heading + 正文                        | success → header,rich_text      |
| header,rich_text | 再送原heading-only payload            | success → header                |
| rich_text        | pipe table-only（同列working suffix） | block_mismatch；舊rich_text不變 |
| rich_text        | pipe table + 空行 + ` ...`            | success → table,rich_text       |
| table,rich_text  | table + 正文                          | success → table,rich_text       |
| table,rich_text  | 再送原table-only payload              | success → table                 |

每則最後皆更新成含synthetic完成說明的訊息，API成功。此為真Slack server重現，不是mock：同一heading/table-only payload對初始rich_text失敗，經mixed block中間態後成功，證明至少這些案例依赖既有message結構，而非payload本身永遠不合法。

重要修正：方案D（單純切換markdown_text）在此矩陣未修復，兩個only案例同樣block_mismatch。空行把working indicator變成獨立rich_text的更新可成功，與production「內容增長後恢復」一致。這定位了具體可重現的rich_text-only → header-only/table-only轉換，但不表示所有mixed-block排列、並發、streaming或更長payload均已驗證，也不能推論Slack內部位置匹配演算法。

後續修復可優先研究獨立provisional indicator／必要時相容中間態，配合失敗節流；終稿只有heading/table及既有mixed target仍需測試，不因這四組成功就宣稱完整修復。先前A+B與D實驗優先的team建議為live驗證前結論，應依此結果重新評估。

## 本地 daemon 端到端驗證（2026-09-14）

以修正版dist/main.js、`--sandbox image:ghcr.io/geminixiang/mikan-sandbox:latest` 啟動本地daemon，Colima Docker已運作。從已登入Slack瀏覽器的本地DM送出H2/T2合成要求，經正常intake與模型生成而非直接API注入回答。Heading回答ts `1789367154.708209`，終態header+rich_text；table回答ts `1789367198.332949`，終態table（6 rows，含header）+rich_text。兩則皆有後續edited時間且不含working indicator，daemon log無error/failed/block_mismatch。附帶rich_text為回答的歸屬標示，因此此E2E不取代前節純header/table終稿的API驗證。

本次要求不使用工具，未驗證docker exec工具路徑；image模式准入成功不等同工具已在container執行。測試後已停止本次daemon，Colima保持運作。未commit、push或部署。
