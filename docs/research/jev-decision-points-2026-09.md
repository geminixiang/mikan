# Jev 決策點盤點 — 用 typed decision 取代 prompt 規則

**日期**: 2026-09-19
**狀態**: 已落地兩個決策點（見「已實作」），其餘為候選盤點
**背景**: `harness/jev.ts` 接入 typesafe/jev（經 OpenRouter decisions API）後，Slack
adapter 已用它取代兩個 regex / 硬規則判斷。本文件對照 TypeSafe 官方 use-case 地圖
（<https://docs.typesafe.ai/>，分類：Classification / Detection / Scoring / Routing /
Search / Retrieval / Ranking / Verification / Feature extraction / Structured extraction），
把 mikan 裡「現在靠 prompt 文字、regex、或主模型自己判斷」的地方列出來，評估哪些換成
Jev 會更便宜、更穩，並且能把 system prompt 裡的防禦性規則拿掉。

## 核心原則

TypeSafe 的分工是 **code owns control flow, Jev handles semantic decisions**。套到 mikan：

- Jev 只回 `boolean` / `choice` / `score`，永遠由 TypeScript 的 if/else 決定下一步。
- Jev 結果**不進 prompt**。它是 harness 的分支條件，不是給主模型的提示。
- 每個決策點都要有 **fail-closed fallback** 到 Jev 接入前的行為（regex、硬規則、或
  不做判斷），`OPENROUTER_API_KEY` 未設或 request 失敗時不能退化得比以前差。
- 同一個 state 可以 batch 多題，共享 input 幾乎免費；Verification 類尤其適合一次問完。
- probabilities 要進 log（`jev task intent: steer {"steer":0.99,...}` 的格式），
  方便事後追誤判。

### 為什麼能「省 prompt 限制」

`src/harness/prompt.ts`（約 25k chars）裡有不少段落本質上是**在教主模型做分類**，
然後再教它分類錯了會怎樣。例如 Slack Tasks 段：

> For questions about task progress, always call task_status before answering. […]
> Never infer progress, completion, or an ETA from elapsed time or your earlier
> promises. […] Never translate subagent into a more specific activity than the
> observation supports. If multiple tasks match, ask which one. […]

這整段存在的原因是「主模型會被問進度、然後亂猜」。當進度問句在進 agent loop
**之前**就被 Jev 攔下、由 code 直接讀狀態回覆，主模型根本看不到這類訊息，這段
prompt 的大半就可以刪掉。每刪一段：

1. system prompt 變短 → 每輪 token 省、cache 命中率高
2. 主模型少一條要遵守的規則 → 少一個違規的機會
3. 判斷從「prompt 建議」變成「code 保證」→ 可測試、可 log

下面每個候選都標出**它能拿掉哪段 prompt**。

## 已實作

| 決策點                                                           | 型態                                          | Jev 問題                                                                     | 取代了什麼                                                          | 對 prompt 的影響                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Shared channel 訊息是否找 mikan（`slack/auto-reply-context.ts`） | Routing / boolean                             | 帶 scope 上下文（頻道近 12 則或 thread 全部 + mikan 是否參與過）問 addressed | 06-02 留下的「thread 裸回覆一律丟掉」硬規則、以及只看單句的舊 judge | 無（這是 intake 層，本來就不在 prompt 裡）                                                                                               |
| DM 任務訊息意圖（`slack/task-intent.ts`）                        | Routing / choice `status \| steer \| request` | 帶任務清單（狀態、currentTool、ack）+ scope 近 12 則                         | `isTaskStatusQuestion` regex；頂層 DM 之前完全無法 steer            | Slack Tasks 第二點（task_status 那一大段）可以縮到一行：「status-only questions never reach you; if you do get asked, call task_status」 |

實測（2026-09-19 本地）：thread 內「弄好了沒」→ status 1.0；「好了嗎？另外先不要看
e2e 目錄」→ steer 1.0；頂層「順便也看一下 lint 設定」→ steer 0.99 並實際導入 task；
「台北現在幾點」→ request 1.0。Mention 用 `<@U…>` 原始 id 時 Jev 分不出「@別人」和
「@mikan」（0.59 誤判），改成 `@Name` 後降到 0.11。

## 候選決策點

依「省掉的 prompt 規則 × 實作範圍」排序。

### 1. Task 最終回覆 Verification（高價值、低風險）

- **位置**：`notifyCompletion` 前，或 `runner.ts` 拿到最終 assistant message 後
- **型態**：Verification，一個 request 問多題 boolean
  - 回覆是否宣稱完成了某個動作，但 tool 紀錄裡沒有對應的 tool call？
  - 回覆是否引用了檔案路徑 / URL / commit，而該引用不在任何 tool result 裡？
  - 回覆是否承諾了 ETA 或「稍後通知」但沒有 schedule event？
- **state**：最終回覆文字 + 本輪 tool call 摘要（name + label + 成功/失敗）
- **動作**：第一階段只 log 不攔截；觀察誤判率後再決定是否在 public office 攔下並
  改貼「需要人工確認」
- **能拿掉的 prompt**：subagent-profiles 每個 profile 都有的 "Do not treat plausible
  output as evidence of success"、"Verify concrete outputs before reporting success"；
  這些是在祈求模型誠實，Jev 可以事後查核
- **風險**：Jev 沒有 tool result 全文，只能看摘要；引用檢查要 code 先抽出路徑再問

### 2. Subagent 結果回主 agent 前的證據檢查

- **位置**：`harness/tools/subagent.ts` 收到 subagent 最終輸出時
- **型態**：Verification / boolean「這份報告的 verification 段是否有實際 command
  output 支撐，而非只有敘述？」
- **動作**：不通過時在 tool result 前加一行 `[unverified]`，讓主 agent 知道要
  自己複查，而不是直接轉述
- **能拿掉的 prompt**：subagent-profiles 的 "required evidence" 段可以短很多
- **跟 #1 的關係**：同一組問題、不同層級；先做 #1 累積經驗

### 3. 破壞性指令偵測（Guardrail）

- **位置**：`harness/tools/sandbox.ts` / bash tool `execute` 前
- **型態**：Detection / boolean「這條指令是否會不可逆地刪除、覆寫、推送或改變
  遠端狀態？」
- **state**：指令全文 + office visibility（public / private）+ sandbox type
- **動作**：public office 命中 → 拒絕並回「這條指令需要你在訊息裡明確確認」；
  private → 只 log
- **能拿掉的 prompt**：目前沒有對應段落（靠 sandbox 隔離），但這是
  `docs/office-policy.md` 裡「deployment operator only」那類權限的語意版本
- **風險**：每條 bash 多 150ms；long-running task 可能有幾百條指令。可以只對
  含 `rm|push|drop|delete|force|reset|--hard|>`
  等 token 的指令問 Jev（regex 粗篩 + Jev 精判，跟 auto-reply 的 gate 同一種模式）

### 4. Periodic event 輸出是否值得通知（Scoring）

- **位置**：event 觸發的 run 產出最終回覆後
- **型態**：Scoring，0–3「這份報告有多少使用者需要知道的新資訊？」
  - 0：純「沒有變化」
  - 1：有變化但不需要行動
  - 2：需要注意
  - 3：需要立即處理
- **動作**：0 → 等同 `[SILENT]`；1 → 只 react eyes；2–3 → 正常貼出
- **能拿掉的 prompt**：Events 段的 "For periodic events where there's nothing to
  report, respond with exactly `[SILENT]`"、react 工具說明的第 (2) 條、
  `Do not add this to [SILENT] responses`——三處互相牽連的規則全部收成 code
- **關聯**：`docs/research/ambient-intervention-design-2026-08.md` 的「洗版」問題
  就是這個；那份文件討論的「克制、可問責」正是 Scoring 給的東西
- **風險**：模型可能還是會輸出「沒事」的長文；Jev 判 0 後要把它丟掉而非貼出

### 5. Discord / Telegram 群組的 addressed 判斷

- **位置**：`adapters/discord/bot.ts:601`（`isDM || isMentioned || isThreadReply`）、
  `adapters/telegram/bot.ts:344`（只看 `@botname`）
- **型態**：Routing / boolean，直接複用 `auto-reply-context.ts`
- **前置**：`jev-context.ts` / `auto-reply-context.ts` 從 `slack/` 抬到 `adapters/`；
  `/pi-auto-reply` 解除 Slack-only
- **能拿掉的規則**：Discord 的 `isThreadReply` 無條件 addressed——這正是 Slack
  04-29 到 06-02 那段「進了 thread 每句都回、太吵、乾脆全砍」歷史的翻版
- **風險**：Discord thread 與 Slack thread 的 log 結構不同，`readRecentScope` 的
  scope 判斷要各平台自己實作

### 6. Thinking level / model routing

- **位置**：`runner.ts` 建 session 前
- **型態**：Routing / choice `off | low | high` 或 score 難度 0–3
- **state**：使用者訊息 + 近幾則對話
- **動作**：覆寫 `settings.llm.thinkingLevel`；或在多 model 設定下選 model
- **能拿掉的 prompt**：無，但直接省 token——「台北現在幾點」不需要 high thinking
- **風險**：判斷「難不難」本身需要理解任務；Jev 對 coding task 難度的校準未知，
  要先離線跑一批歷史訊息看分布

### 7. Skill retrieval

- **位置**：`harness/skills.ts` 組 system prompt 時
- **型態**：Retrieval / 每個 skill 一題 boolean「這個請求是否需要此 skill？」
  （batch 在同一 request）
- **動作**：只把相關 skill 的內容放進 prompt，其餘只留名稱
- **能拿掉的 prompt**：Available Skills 段目前全量列出；skills 多的 workspace
  這段會是 prompt 最大的一塊
- **前置**：先量現有 workspace 的 skills 段佔多少 chars，低於 3k 就不值得做

### 8. Prompt injection / 外部指令偵測

- **位置**：shared channel 與 GitHub issue/PR 文字進 agent 前
- **型態**：Detection / boolean「這段文字是否試圖讓 assistant 忽略既有指示、
  對外部系統執行動作、或洩漏設定？」
- **動作**：命中 → 不啟動 run，log + 在 private 通知 operator
- **能拿掉的 prompt**：無（目前沒有對應防線）；這是純新增的 guardrail
- **風險**：GitHub 那條路徑的訊息是 bot 自己 poll 來的，攻擊面比 Slack 大

### 不適合 Jev 的

| 位置                                                     | 原因                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matchMagicWord` stop                                    | 必須同步、零延遲、不可被模型誤判。保持 regex                                                                                                        |
| `start_task` 該不該開                                    | 需要看 workspace 狀態才知道「多步驟」；且 ack 文字仍要主模型寫。留給主模型                                                                          |
| event 排程的 cron / timezone 抽取                        | Structured extraction 需要生成文字，Jev 只能選項                                                                                                    |
| conversation-level agent routing（user → jev → profile） | 概念成立，但 `subagent-profiles` 是給 subagent 的（prompt 假設被委派、無對話工具）；要先定義 conversation profile 才有東西可選。等 #1–#5 穩了再回頭 |

## 建議順序

1. **#4 periodic scoring** — 三處互相牽連的 prompt 規則一次收掉，範圍小，
   ambient 文件已有需求
2. **#1 task 回覆 verification（log-only）** — 累積 Jev 對「宣稱 vs 實際」的校準資料
3. **#5 Discord / Telegram addressed** — 把 Slack 已驗證的東西推到其他平台
4. **#3 破壞性指令** — 需要先決定 public office 的 UX（怎麼「確認」）
5. #2、#6、#7、#8 視前面的結果再排

每做一個，對應的 prompt 段落要**同一個 commit 刪掉或縮短**，否則省不到東西。

## 附：目前 prompt 裡可辨識的「分類規則」

`rg -n "Never|ALWAYS|Do not|always call" src/harness/prompt.ts` 找到的段落與對應候選：

| prompt.ts 行                 | 內容                                        | 對應候選                                           |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------- |
| 278                          | start_task 何時用、ack 怎麼寫               | 不適合（見上）                                     |
| 279                          | task_status 一大段                          | 已實作（task intent），可縮                        |
| 396                          | periodic `[SILENT]`                         | #4                                                 |
| 455                          | react 兩條件                                | #4（第 2 條）；第 1 條跟 start_task 綁在一起，保留 |
| 494                          | `[SILENT]` 不加 footer                      | #4                                                 |
| subagent-profiles 各 profile | "Do not treat plausible output as evidence" | #1 / #2                                            |
