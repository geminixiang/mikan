# Ambient Intervention Design — 主動插話功能設計

**日期**: 2026-08-28
**狀態**: 設計草案，尚未實作
**背景**: Anthropic 於 2026-06-23 發布 Claude Tag（Slack 原生團隊協作 agent），其
「takes initiative（ambient）」能力——主動追蹤使用者可能需要知道的事、標記相關資訊、
跟進已冷掉沒解決的討論串——是 mikan 目前明顯缺失的一塊。本文件記錄 mikan 對標 Claude Tag
後，針對「ambient 主動插話」這個功能的設計討論結果。

## 產品定位（前提，不是這份文件的結論）

mikan 的核心優勢是讓非 RD（主管、業務、客服等）不用理解 AI agent 知識就能直接在既有
IM 平台上與 agent 互動。這個定位排除了「做獨立 web app/桌面應用」的方向——那等於跟
Claude Code / Codex 桌面版正面競爭 IM 之外的場景，沒有意義。因此 ambient 功能的全部
設計都發生在 IM 平台既有介面內，不引入新的介面形態。

## 對標 Claude Tag：mikan 現況盤點

| Claude Tag 能力                                   | mikan 現況                                                                                                                | 差距                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Multiplayer（一頻道一 agent，人人可接手）         | 已有 —— session key 本來就是 per-channel/per-thread 共用，不是 per-user                                                   | 無                           |
| Works asynchronously（背景跑任務、自主排程）      | 已有 —— `event` 工具支援 immediate/one-shot/periodic                                                                      | 無                           |
| Learns over time（單頻道累積 + 經授權跨頻道學習） | 只有單頻道版（`MEMORY.md`），無跨頻道學習機制                                                                             | 另立專案討論，不在本文件範圍 |
| Admin 治理（per-channel/org 花費上限、audit log） | `/admin` portal 只有觀察能力（token usage/cost 按 channel 追蹤），無 spend limit、無「誰觸發了哪個任務」的 audit trail    | 未評估優先順序，本文件不展開 |
| Takes initiative（ambient）                       | 幾乎沒有。僅有一個標記 `@deprecated` 的 `evaluateAutoReplyPolicy`（`src/trigger.ts`），做「該不該自動回話」的同步二元判斷 | **本文件的主題**             |

## 核心判斷：目標不是「像人一樣懂氣氛」，是「克制、可問責、會學習」

三個獨立模型（gpt-5.6-sol、gemini-3.7-flash-high、MiniMax-M3）交叉討論後的一致結論：
ambient 插話本質上是社交判斷（要不要在別人忙的時候打斷），LLM 做不到普遍意義上的
「懂氣氛」——不同公司、頻道、主管對插話的容忍度差異太大，沒有一個判準能通吃。

因此不該把目標設在「提高判斷準確率」，該設在**把打擾的下限做到最低**，並且讓每次
插話都可問責、可撤回、能從回饋中降低頻率。gpt-5.6-sol 的原話：「真正的人性化，首先
是讓 agent 學會不說話。」

## 失敗模式圖鑑

三個模型獨立舉出的具體場景高度重疊，收斂為四大類：

### 1. 翻舊帳（把「刻意延後」誤判成「遺忘」）

使用者已經明確說「這個先不處理，等週三再說」，agent 週一就跳出來提醒「還沒處理」。
使用者的延遲是有意為之的時序安排，agent 沒讀懂延遲和遺忘的差異。

### 2. 灌爆頻道（把進度更新當獨立事件處理）

一個長任務拆成多個子步驟（lint / test / build / deploy / verify），agent 每完成一步
就發一則訊息。頻道被自己的進度通知洗版，真正重要的訊息（例如 deploy failed）被淹沒。

### 3. 搶話 / 誤判情緒現場

- 使用者正在打字（訊息還沒送出）時，agent 因偵測到相關關鍵字提前跳出來，覆蓋掉使用者
  正要說的話。
- 客戶在 support 頻道情緒激動時，agent 跳出來「整理重點」，把情緒現場當資料來源處理，
  使用者覺得被當成數據，更生氣。

### 4. 過度關聯（表面語意相似 ≠ 真的相關）

`#frontend` 提到「React 元件需要 refactor」，三天後 `#backend` 討論 API 設計，agent
主動把兩者關聯起來要求「對齊」，但兩件事完全無關。

### 其他值得記錄的模式

- **社死翻舊帳**：主管問「誰能認領？」全組已讀不回是團隊默契下的尷尬沉默（可能私下已
  在協調），agent 卻公開廣播「尚無人回應」，把默契打破成公開難堪。
- **義務化**：善意提醒（「PR 5 天沒 review」）被使用者感受成社會壓力，「選擇」變成
  「被要求」。
- **代理群體決策**：多人討論未達共識就各自散去，agent 事後跳出來「根據對話紀錄 2 票
  贊成 1 票反對，建議採用 A 方案」，把未結論的對話強行結構化成投票結果。

## 設計一：多維度旋鈕（拒絕單一強弱滑桿）

三方一致反對用單一 on/off 開關或線性強弱滑桿控制 ambient 行為。正確設計是至少三個
獨立維度的組合：

### 維度 1：場合 / 主題（topic allow/deny）

使用者可以用自然語言定義範圍，系統編譯成結構化政策（不是讓 LLM 每次讀原始字串），例如：

- 「只在 `#incident-*` 頻道插話」
- 「`#random` / `#watercooler` 永遠不要插話」
- 「只要提到 deploy / production / outage 就要知道」

### 維度 2：打擾形式分級（Escalation Ladder）

不是「要不要插話」的二元問題，是「用什麼形式插話」的分級問題。每次判斷「該介入」後，
永遠先選最低必要等級：

```
Level 0 — 靜默觀察：只更新內部記憶/知識庫，不發出任何聲音
Level 1 — Thread 內輕聲提醒：只回在原討論串裡，絕不進主頻道；語氣自帶退路
          （例：「先稍微頂上來一下，如果線下已經 sync 過了請直接忽略」）
Level 2 — 主頻道短訊：中等打擾，僅限有把握的場合
Level 3 — 主頻道長訊 + @提及：最高打擾，嚴格限制於高把握度或高風險場合
          （例：明確涉及重大風險、deadline 已至、被明確指名）
```

Level 1 應是預設上限；Level 3 只在少數經管理員明確放行、且有足夠歷史信任的頻道開放。

### 維度 3：頻率上限 / 去重

- 每頻道每日最多主動介入次數（例：2 次）
- 每個討論串（thread）最多提醒 1 次，避免同一個 blocker 被重複發現
- 人類活動後的冷卻時間（例：30 分鐘內不主動插話）
- 安靜時段（quiet hours）

### 分層預設（Preset），可按組織 / 頻道覆寫

```
組織預設（Organization default）
  ↓
頻道覆寫（Channel override）：例如 incident 頻道設為 Incident 模式，
                                閒聊頻道設為 Off
  ↓
討論串層級的臨時操作（Thread-specific snooze / resolve）
```

建議的頻道層 preset 分類：

- **Off** — 完全不主動
- **Observe** — 只做靜默記錄，不對外發言
- **Nudge** — 標準模式，僅 Level 1（thread 內提醒），不主動進主頻道，非重大事件不 @人
- **Incident** — 改變判斷標準而非只是「更吵」：高 urgency 可立即公開介入，非立即有用
  的資訊一律延後，字數更嚴格限制，不提出非當下行動的建議

## 設計二：「冷掉」判斷 —— 用顯式解決訊號，不用時間閾值

核心問題：「已解決不需要提」和「真的被遺忘該提醒」表面上看起來一樣（都是沒人繼續回
覆），但正確反應完全相反。三方一致結論：**不要用 `now - lastMessageAt > N` 這種時間
閾值判斷冷掉，要靠是否存在明確的關閉 / 接手訊號。**

### 建議引入輕量的討論狀態機

```
NoAction → OpenQuestion → Committed → Waiting → Deferred → Resolved → Superseded → Unknown
```

### 應該抑制提醒的訊號（closure signals）

- 明確關閉語（「已修好」「不用了」「先不做」「結案」「先到這裡」）
- 外部狀態變化（PR merged、issue closed）
- 承諾/接手類 emoji 反應（👀 表示已看到會 follow、🔜 表示已排進行程）
- Thread 內已有人給出解決方案，即使主頻道沒人接話
- 原提問者已撤回需求或離開專案

### 應該觸發提醒的強訊號

- 明確問句且無人回覆（「@Bob 可以在週五前確認合約嗎？」）
- 明確承諾且已過承諾時間仍無下文（「我明天開 PR」，兩天後仍無 PR）
- 明確 owner + deadline（比「這個之後處理一下」可靠得多）
- 使用者主動要求的 follow-up（「mikan，下週如果還沒結論提醒我」）— 這幾乎不需要社交
  推測，優先權最高

### Waiting 與 Deferred 必須是一級狀態，不能被當成「冷掉」

- **Waiting**：等待外部條件（客戶、法務、另一個 team），只有等待條件改變或明顯超時
  才提醒，不應每天重新發現同一個 blocker
- **Deferred**：使用者明確說了「下季度再看」，在指定時間之前完全不提

### 訊號不足時，不要在頻道公開發問

當一個 thread 同時存在「可能的承諾」+「像自然結束的收尾語」+「沒有明確 owner」+
「沒有 deadline」時，正確行為是收進私人 digest（發給頻道 owner 或原始提問者，Level 1
或私訊等級），而不是公開質問：

```
可能未解決：Landing page redesign
最後活動：4 天前
討論結束於「再看看」，不確定是被延後還是被放棄。
[標記已解決] [下個月提醒] [指定 owner]
```

### 學習機制：一鍵負回饋

每次插話下方提供低成本回饋（按鈕 / emoji 反應）：

```
[已解決] [週五提醒] [不需要處理] [提醒太多次了]
```

使用者按下 ⛔（或等價的「提醒太多次了」）時，系統把這次判斷的特徵（訊息模式、時序詞、
頻道）結構化記錄下來，作為使用者層級的負向偏好，跨頻道生效，避免重複踩同一種雷。

## `evaluateAutoReplyPolicy` 的處置：不救、但保留兩個資產

三方一致判斷：不能直接在現有函式上加功能，因為它的形狀從根本上不適合 ambient 場景。

**為什麼舊函式解決的是不同問題**：

- `evaluateAutoReplyPolicy` 是**同步攔截器**——每來一條新訊息，跑一次 LLM judge 決定
  「現在要不要回」。這只適用於「有人沒 @ 機器人但講了關鍵字，想即時觸發」的場景。
- Ambient 要處理的是**非同步、跨時間**的候選情境（追蹤冷卻中的討論、跨頻道相關資訊），
  舊函式沒有時間/狀態維度，是無狀態的純文字判斷。
- 舊函式的輸出是自由文字 YES/NO，沒有「為什麼」的結構，無法治理、無法用於學習。

**應該保留的資產**：

1. **使用者自訂規則這個介面本身** —— 但不能讓 LLM 每次直接讀原始規則字串（這是把
   「判斷問題」錯當成「長上下文問題」），要先把使用者的自然語言規則**編譯成結構化
   政策表**，ambient 判斷時查表，不重新解析字串。
2. **決定必須是結構化 enum，不是自由文字** —— 最終輸出應該是可審計、可路由的結構，
   例如：
   ```ts
   type AmbientDecision = {
     action: "silent" | "private_digest" | "thread_nudge" | "channel_alert";
     level: 0 | 1 | 2 | 3;
     reason: string; // 引用了哪個政策維度，供使用者審查「為什麼被推」
     confidence: number; // 低於閾值一律 silent
     target: string; // thread owner / channel / 特定使用者
     evidence: string[]; // 引用的訊息 id
     deduplicationKey: string; // 避免同一個 blocker 被重複發現
     notBefore?: string;
     expiresAt?: string;
   };
   ```

**建議的三層判斷架構**（區分哪一層可以讓 LLM 有彈性、哪一層必須是確定性規則）：

```
第一層 — 候選偵測（LLM，允許較高 false positive，因為還沒真的發言）
  判斷是否存在問題 / 承諾 / deadline / blocker / 相關新資訊

第二層 — 確定性政策閘門（不用 LLM，必須 deterministic）
  ambient 是否啟用、頻道允許哪些行為、quiet hours、
  每日 social budget、是否已提醒過、cooldown、
  是否已有 Resolved/Deferred 標記

第三層 — 社交呈現判斷（LLM）
  這次介入是否真的增加價值、選擇最低打擾的 delivery mode、
  語氣、是否該先承認不確定性
```

最終原則：優先順序永遠是「保持沉默 → 收入 digest → 私下詢問 → thread 內提醒 →
channel 公開插話」，選擇能達成目的的最低干擾行為。

## 落地順序：先證明「知道何時閉嘴」

不建議一次做完所有人性化細節（會陷入 LLM judge 調參地獄），建議分階段推進，每一階段
都先驗證「克制」而不是急著上「主動」：

### Phase 1 — Shadow Ambient（先不發言，只記錄判斷）

Agent 正常產生判斷，但完全不對外發言。Admin 可以看到類似這樣的統計：

```
今天 mikan 考慮了 14 次介入
會發出：3 次
被 social budget 抑制：2 次
被判斷為已解決而抑制：4 次
信心度過低而抑制：5 次
```

頻道 owner 對候選內容評分（如果真的發出會不會有幫助？是否誤判 resolved/waiting？是否
洩漏跨頻道資訊？）。這個階段的目標是先測準「知道何時該閉嘴」，而不是測「發言準不準」。

### Phase 2 — 私人 digest + 明確承諾提醒

只允許最低風險的介入形式：私人 digest、使用者明確要求的提醒、有明確 owner+deadline 的
承諾追蹤。每個 thread 最多一次，不做開放式的「我覺得這可能相關」。

### Phase 3 — Thread-local ambient

放行 unanswered questions、stale commitments、公開來源的相關資訊，但一律只在原 thread
內回覆，不進主頻道。

### Phase 4 — Channel-level stewardship

只有經管理員明確啟用、且前面階段的 shadow metrics 足夠好的頻道，才允許在頻道層公開
主動發言（Level 2/3）。

## 兩週可達的第一版範圍（依 MiniMax 建議整理）

- 結構化政策編譯器：使用者自然語言規則 → 結構化 `AmbientPolicy` 表
- 場合/主題維度 + 打擾形式分級（Level 0/1）
- ⛔ 一鍵負回饋機制
- Level 1（thread 內回覆）作為預設且唯一對外形式，不進主頻道
- Shadow mode 先跑，觀察指標達標後才逐步放行 Level 2

**延後到之後階段**：情緒張力感知、時間上下文（行事曆整合）、個人化的「冷掉」判斷模型、
主動學習的偏好模型。

## 未決問題（留給後續設計）

- `AmbientPolicy` 的儲存位置與是否要走 vault/workspace-projection 現有機制，還是獨立
  於 office 的新配置面。
- Shadow mode 的統計資料要不要出現在 `/admin` portal，或者只在頻道內部可見。
- 「冷掉」狀態機（`NoAction/OpenQuestion/Committed/...`）要不要落地成真實的持久化結構，
  還是每次判斷時由 LLM 從對話歷史即時推導。
- 與「跨頻道學習」專案（尚未討論）的介面關係——例如「相關資訊來自其他頻道」這個 ambient
  行為，本質上依賴跨頻道學習的授權範圍，兩者不完全獨立。

## 附錄：討論方法

本設計由三個獨立運行的模型會話（gpt-5.6-sol、gemini-3.7-flash-high、MiniMax-M3，經由
Herdr 並行運行，同一份 prompt 各自獨立回答，互不看彼此輸出）在 Round 9 產出，本文件
為協調者整理三方共識與互補觀點後的結果，不代表單一模型的完整回答。grok-4.6 因 API
額度冷卻未參與本輪。
