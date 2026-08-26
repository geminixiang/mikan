# mikan Extension 需求腦力激盪：真實企業使用者視角

以下假設 mikan 被安裝在組織日常使用的 Slack、Discord、Telegram 或 GitHub 對話中。重點不是「讓 agent 多會一個 prompt」，而是把持續運作、權限、互動、外部系統整合與可稽核流程做成可靠的產品功能。

標記說明：**【API 缺口】**代表需求無法只靠目前 `MikanExtensionApi` 穩健完成，或只能以高成本輪詢／自行維護脆弱狀態繞過。

---

## 1. 軟體產品團隊（Slack + GitHub）

### 1.1 PR 值班分派器（PR Duty Router）

- **需求**：新 PR 或 PR 進入 ready-for-review 時，依 repository、CODEOWNERS、當週值班與目前待審數量，指派 reviewer，並在團隊 Slack 頻道貼出可接手／略過按鈕。
- **觸發方式**：
  - GitHub issue/PR conversation 收到 webhook 對應的新事件。
  - `/review-duty status`、`/review-duty skip @user`。
  - 每日上午 callback schedule 做逾期檢查。
- **使用 API**：
  - `registerCommand` 提供狀態與人工覆寫。
  - `schedules.upsert` + `onCallback` 檢查逾期 PR。
  - `listUsers`、`openDm`、`notify` 發送提醒。
  - `blockkit.post/onAction/update` 讓 reviewer 接手、略過或轉派。
  - `secrets` 讀 GitHub App/token；`sharedDataDir` 保存跨頻道輪值與分派紀錄。
  - `subagent.run` 可用於把 PR 描述整理成短摘要，但分派本身應採確定性規則。
- **為什麼 bash/edit/write 不適合**：agent 工具只能在一次 run 中操作檔案或呼叫 CLI；它們不應長期持有 GitHub 權限、處理 webhook、維護跨 conversation 的唯一分派狀態，也無法提供可靠的按鈕互動與定時重試。
- **【API 缺口】**：
  - 沒有 extension 可註冊的通用外部 webhook/event ingestion API；目前只能期待 GitHub adapter 將事件轉成對話訊息，事件種類與結構可能不足。
  - `listUsers()` 只有基本 active users，缺少 user group、角色、時區、休假／presence 等企業目錄資訊。
  - 沒有更新 GitHub PR reviewer、label、status check 的平台原生 API；extension 必須自行用 secret 呼叫 GitHub REST/GraphQL。

### 1.2 Deploy Gatekeeper

- **需求**：部署 production 前在 Slack 建立審批卡，要求服務 owner 與當班 SRE 各一人核准；核准後呼叫 CI/CD deployment API，逾時自動失效。
- **觸發方式**：`/deploy service version environment`，或 CI webhook 建立待審請求。
- **使用 API**：
  - `registerCommand` 驗證格式並建立請求。
  - `blockkit.post/onAction/update` 處理 approve/reject，顯示審批者與狀態。
  - `listUsers` 驗證使用者身分；`secrets` 取得 CI/CD credential。
  - `schedules` 建立逾時 callback；`notify/openDm` 催簽。
  - `paths.sharedDataDir` 保存 idempotency key、審批軌跡與部署結果。
  - `on("tool_call")` 阻止 agent 直接執行繞過 gate 的 production deploy 指令。
- **為什麼 bash/edit/write 不適合**：部署審批是安全邊界，不能依賴模型「記得先問」。一般 agent run 也不適合保存不可竄改的審批狀態、等待數小時的多人互動或安全地處理重複 callback。
- **【API 缺口】**：
  - Block Kit action event 有 `userId`，但 API 沒有群組／角色／權限查詢，無法確認某人是否真的是 service owner 或 SRE approver。
  - 缺少 modal、表單驗證、select 動態 options 等較完整互動面；只靠 message blocks 會讓複雜部署參數輸入很笨重。
  - 沒有 extension 專用的 audit-log sink 或 append-only host storage；自行寫 SQLite/JSON 不能等同企業稽核紀錄。

### 1.3 Incident Timeline Recorder

- **需求**：事故頻道建立後，自動收集帶有特定 emoji 的關鍵訊息、部署事件與決策，持續產生 timeline，結案時上傳 Markdown/PDF 並建立 postmortem issue。
- **觸發方式**：`/incident start SEV2 checkout latency`；訊息 reaction 或明確 `/incident mark`；`/incident close`。
- **使用 API**：
  - `registerCommand` 管理事故生命週期。
  - `fetchHistory` 回補訊息；`react` 標記已收錄項目。
  - `schedules.onCallback` 定時保存快照與催辦。
  - `subagent.run` 產生事件摘要／草稿；`uploadFile` 上傳 timeline。
  - `notify` 將狀態同步到主管頻道；`sharedDataDir` 保存事故狀態。
- **為什麼 bash/edit/write 不適合**：檔案工具可以產生單次報告，但不會持續訂閱平台事件，也不能可靠辨識誰在何時對哪則訊息加 reaction；事故紀錄還要求跨 run 去重與可追溯性。
- **【API 缺口】**：
  - 現有 hooks 聚焦 agent run，沒有一般平台 message-created、message-edited、reaction-added、channel-created 事件 hook。
  - `fetchHistory` 是輪詢且欄位／分頁受 adapter 限制；缺少 cursor、message edit/delete provenance 與完整 thread/channel metadata。
  - `uploadFile` 沒有回傳 file id/URL，也不能指定其他 conversation 或 thread，後續引用與跨頻道發布不方便。

---

## 2. 客服與 Customer Success 部門（Slack Connect／內部 Slack）

### 2.1 SLA Watchtower

- **需求**：監控客戶支援頻道的新問題，依方案等級設定首次回覆與解決期限；即將違約時提醒 owner，違約後升級到值班主管。
- **觸發方式**：客戶新訊息、support emoji／標籤、定期 callback schedule；`/sla claim`、`/sla resolve`。
- **使用 API**：
  - `fetchHistory` 讀 thread 回覆；`listUsers` 對應客服人員。
  - `schedules` 建立每案 deadline；`notify/openDm` 提醒與升級。
  - `blockkit` 提供 Claim、Waiting on customer、Resolved。
  - `registerCommand` 處理非 Slack 平台或手動操作。
  - `secrets` 查 CRM 的客戶方案；`sharedDataDir` 保存 ticket 狀態。
- **為什麼 bash/edit/write 不適合**：SLA 計時必須跨重啟持續、避免重複升級，且需要在沒有模型 run 時立即接住訊息。讓 agent 用 shell 輪詢會浪費模型與運算，也容易漏掉事件。
- **【API 缺口】**：
  - 沒有 inbound message event subscription，只能定期 `fetchHistory`，容易延遲且需自行管理 watermark。
  - `notify` 只有純文字；Block Kit 目前 Slack-only，Discord/Telegram 無統一的 interactive component abstraction。
  - 缺少 conversation/channel metadata（頻道名稱、topic、是否 Slack Connect、成員），難以自動判斷客戶與內部頻道。

### 2.2 PII Redaction Guard

- **需求**：客服貼出信用卡、身分證、token 或客戶秘密時，在內容送入模型前遮罩；若 agent 工具輸出包含敏感資料，也需遮罩並通知資安窗口。
- **觸發方式**：所有 agent run 的 prompt/context/tool result；可由 `/pii explain` 查詢被攔截原因。
- **使用 API**：
  - `on("before_agent_start")` 改寫 prompt 或阻擋。
  - `on("context")` 清理歷史 transcript。
  - `on("tool_result")` 清理工具輸出。
  - `on("message_end")` 做最後輸出掃描。
  - `notify/openDm` 發出不含原文的告警；`secrets` 取得企業 DLP API credential。
- **為什麼 bash/edit/write 不適合**：敏感資料必須在模型看到之前攔截；等模型主動呼叫 bash 已經太晚。安全控制也不能依賴模型自行決定是否執行。
- **【API 缺口】**：
  - hooks 的錯誤「只記錄、不阻斷」對一般 extension 友善，但對 fail-closed DLP 不足；DLP 服務超時時可能讓未掃描內容繼續進模型。
  - `message_end` 只能改 agent message，缺少對 extension `notify`、`blockkit.post`、`uploadFile` 的統一 outbound policy hook。
  - 沒有安全的 quarantine／security event API，也沒有標準化 audit metadata（policy id、rule match、hash、處置結果）。

### 2.3 Voice-of-Customer Tagger

- **需求**：把客戶 thread 分類成 bug、feature request、billing、churn risk，將高價值案例同步到 CRM/產品看板，每週產出趨勢摘要。
- **觸發方式**：thread 解決時 `/voc close` 或 Resolved 按鈕；每週 schedule。
- **使用 API**：
  - `fetchHistory({threadTs})` 收集完整案例。
  - `subagent.run` 依 JSON schema 回傳分類、產品區域、情緒、證據句。
  - `secrets` 呼叫 CRM/Jira/Linear；`registerCommand` 與 `blockkit` 讓客服確認／修正標籤。
  - `sharedDataDir` 去重；`schedules` 產週報；`uploadFile/notify` 發布結果。
- **為什麼 bash/edit/write 不適合**：模型工具可以臨時整理一個 thread，但無法確保每個結案都走同一 schema、人工修正能回存、外部 CRM 寫入具備 idempotency，或週報跨 conversation 聚合。
- **【API 缺口】**：
  - 缺少結構化平台事件與 thread closed/resolved 概念，觸發仍要靠自訂按鈕或命令。
  - `subagent.run` 是單次 fresh run；缺少 extension 級批次／併發限制與成本預算控制介面。
  - API 沒有取得 conversation 成員或客戶組織身分，難以正確做 tenant/customer attribution。

---

## 3. 大學／企業研究室（Slack + Discord）

### 3.1 Paper Intake & Reading Queue

- **需求**：成員貼 arXiv/DOI/PDF 後，自動擷取 metadata、查重、加入共用閱讀佇列；可投票決定 journal club 論文，會前產生問題清單。
- **觸發方式**：貼連結或附件；`/paper add`、`/paper queue`；每週 schedule 發投票。
- **使用 API**：
  - `before_agent_start` 從 `origin.attachments` 辨識 PDF，或 `registerCommand` 接 URL。
  - `registerTool` 提供 DOI/arXiv metadata 查詢。
  - `subagent.run` 產結構化摘要與討論問題。
  - `blockkit` 投票；`schedules` 排定提醒；`sharedDataDir` 保存跨頻道 bibliography。
  - `uploadFile` 發送閱讀包；`secrets` 存付費文獻服務 API key。
- **為什麼 bash/edit/write 不適合**：一次性工具能下載與摘要一篇論文，但不能自動接住所有成員上傳、維護多人共享去重佇列、處理投票及每週固定流程。共享文獻庫也不應藏在某次 agent workspace 的任意檔案中。
- **【API 缺口】**：
  - 沒有一般 inbound attachment/message hook；`origin.attachments` 只在觸發 agent run 時存在。
  - `blockkit` Slack-only，Discord 研究群無等價投票／選單 API。
  - `uploadFile` 只能上傳本 conversation，無回傳檔案 URL，也缺少下載平台歷史附件的正式 API 契約。

### 3.2 Lab Equipment Booking

- **需求**：預約顯微鏡、GPU 節點或測試設備，檢查衝突、要求資格認證、使用前提醒，逾時未報到自動釋放。
- **觸發方式**：`/book microscope 2026-06-12 14:00 2h`；Slack modal/按鈕；定時 callback。
- **使用 API**：
  - `registerCommand` 處理查詢／取消。
  - `blockkit` 顯示時段與確認按鈕。
  - `schedules` 發提醒、處理 no-show。
  - `listUsers/openDm/notify` 聯絡預約人與候補者。
  - `sharedDataDir` + SQLite 做唯一時段 constraint；`secrets` 串校內身份或行事曆。
- **為什麼 bash/edit/write 不適合**：預約需要原子衝突控制、身份授權及背景計時。模型寫 JSON 檔容易 race；agent 也不應自行判斷誰有操作危險設備的資格。
- **【API 缺口】**：
  - 缺少 modal/date-time picker 的高階介面，純 slash command 易輸入錯誤。
  - `listUsers` 不提供群組、認證資格或可靠 email mapping。
  - 沒有 host 提供的 transaction/lock/storage API；使用 `sharedDataDir` 時所有跨 conversation concurrency 都由 extension 自行承擔。

### 3.3 Experiment Check-in Bot

- **需求**：長時間實驗每隔數小時詢問進度、記錄量測值與異常；若連續未回覆就通知實驗負責人。結束後輸出結構化實驗日誌。
- **觸發方式**：`/experiment start template-id`；排程 DM；按鈕或 thread 回覆；`/experiment stop`。
- **使用 API**：
  - `registerCommand` 開始／停止。
  - `openDm`、`notify` 發 check-in；以回傳 message id 搭配 `fetchHistory({threadTs})` 讀回覆。
  - `schedules.onCallback` 控制下一次詢問與逾時。
  - `subagent.run` 把自然語言回覆轉成 schema；`uploadFile` 匯出 CSV/Markdown。
- **為什麼 bash/edit/write 不適合**：這是數小時到數天的互動 state machine，不是一個可在單次 agent run 完成的檔案任務。定時、重試、未回覆判定與跨重啟恢復必須由 host callback 處理。
- **【API 缺口】**：
  - extension 沒有「收到對某個 bot message 的新回覆」事件，只能輪詢 `fetchHistory`。
  - `fetchHistory` 沒有明確的 message subtype/bot/user guarantees，跨平台 thread 語意也不一致。
  - 缺少取消／關聯一組 schedules 的 API；複雜 workflow 必須自行命名與逐筆刪除。

---

## 4. 開源社群／遊戲社群管理員（Discord + Telegram）

### 4.1 New Member Onboarding Quest（務實版）

- **需求**：新成員加入後私訊社群規則、要求選擇興趣角色、完成簡短介紹；未完成者三天後提醒，完成後在歡迎頻道發布介紹。
- **觸發方式**：member joined；DM 按鈕／命令；三天 callback schedule。
- **使用 API**：
  - 理想上由 member-joined event 啟動。
  - `openDm/notify` 發 onboarding。
  - `registerCommand` 提供 `/onboard` fallback。
  - `schedules` 提醒；`sharedDataDir` 保存狀態。
  - `subagent.run` 可把自我介紹整理成短版，但不負責權限決策。
- **為什麼 bash/edit/write 不適合**：加入事件發生時未必有人呼叫 agent；角色授予與三天後提醒也是平台生命週期操作，不應靠模型或常駐 shell script 偷渡。
- **【API 缺口】**：
  - 沒有 member joined/left、role changed 等平台事件。
  - 沒有讀取／授予 Discord role、Telegram admin status 或 Slack user group 的 API。
  - interactive UI 只支援 Slack Block Kit，Discord buttons/selects 與 Telegram inline keyboard 未被抽象化。

### 4.2 Moderation Case Manager

- **需求**：版主對可疑訊息加 reaction 或執行 `/mod case`，系統保存證據、套用社群規則、由另一位版主覆核，再執行 warning/timeout/ban，並通知當事人申訴方式。
- **觸發方式**：reaction、slash command、使用者檢舉按鈕。
- **使用 API**：
  - `registerCommand` 建案與覆核。
  - `fetchHistory` 保存上下文；`react` 標記已受理。
  - `subagent.run` 只做規則對照與摘要，不自動裁決。
  - `openDm/notify` 通知；`sharedDataDir` 保存 case/audit；`secrets` 串外部 moderation database。
  - `on("before_agent_start")` 可阻擋把私人 mod case 洩漏到公開回覆。
- **為什麼 bash/edit/write 不適合**：timeout/ban 是高權限平台操作，需要明確授權與雙人覆核；一般 agent shell 不該持有管理 token。證據也需要在訊息被刪除前由事件驅動保存。
- **【API 缺口】**：
  - 沒有刪訊息、timeout、kick、ban、role mutation 等 moderation API。
  - 沒有 reaction-added/message-deleted event，因此不能即時建案或保全刪除前證據。
  - 缺少不可竄改 audit log、附件證據保存與 retention policy API。

### 4.3 FAQ Drift Detector

- **需求**：觀察重複提問，找出文件沒有回答或答案已過期的主題；每週向管理員提出「新增 FAQ／更新既有條目」草案，人工核准後才寫入 GitHub docs。
- **觸發方式**：每日 history scan；每週報告；`/faq accept 12`。
- **使用 API**：
  - `fetchHistory` 抽樣公開頻道訊息。
  - `subagent.run` 聚類與提出有引用來源的草案。
  - `schedules` 執行掃描；`blockkit/registerCommand` 審批。
  - `secrets` 呼叫 GitHub API 建 issue/PR；`uploadFile` 發完整報告。
- **為什麼 bash/edit/write 不適合**：agent 可以手動改一次文件，但不應未經審批就持續監控社群並修改公開 FAQ；extension 才能保存候選項、引用、人工決策與去重狀態。
- **【API 缺口】**：
  - `fetchHistory` 以單 conversation 為中心，沒有安全的 workspace-wide conversation inventory/search API。
  - 沒有 channel allowlist、privacy classification 或 message retention metadata；extension 很難保證不掃描私人頻道。
  - 缺少成本／速率限制控制與批次歷史匯出，長期掃描可能昂貴且容易撞平台 rate limit。

---

## 5. 小型數位代理商（同時服務多個客戶，Slack Connect + Discord）

### 5.1 Client Approval Hub

- **需求**：把文案、設計稿或影片版本送進各客戶頻道，收集 approve/revise 與結構化意見；核准後同步到專案管理工具，保留版本與核准人。
- **觸發方式**：`/approval create campaign asset-url`；客戶按鈕；到期提醒。
- **使用 API**：
  - `registerCommand` 建立審批。
  - `blockkit.post/onAction/update` 顯示版本、狀態和決策。
  - `schedules` 催辦；`openDm/notify` 提醒 account owner。
  - `uploadFile` 發附件；`sharedDataDir` 保存跨客戶專案狀態；`secrets` 串 Asana/ClickUp/Drive。
  - `subagent.run` 整理零散修改意見。
- **為什麼 bash/edit/write 不適合**：客戶核准是長時間、多方且具商務效力的流程；一次 agent run 無法可靠等待回覆、辨識核准人、處理版本替換與避免重複同步。
- **【API 缺口】**：
  - `blockkit.post/update` 只能操作本 conversation，無跨 conversation options；跨客戶發布只能退回純文字 `notify`。
  - `uploadFile` 不能指定 conversation/thread、不能上傳 buffer/stream、也不回傳 file id。
  - 沒有 conversation membership／外部訪客辨識，難以驗證按下 Approve 的人是否是授權客戶代表。
  - Slack-only interaction 使 Discord 客戶體驗無法對齊。

### 5.2 Timesheet Nudge & Project Coding

- **需求**：每日下班前 DM 尚未填工時的人，讓他從最近參與的客戶 thread 選 project code，確認後寫入 Harvest/Tempo；主管收到缺漏摘要。
- **觸發方式**：平日 schedule；DM 回覆或按鈕；`/time status`。
- **使用 API**：
  - `schedules.onCallback` 每日執行。
  - `listUsers/openDm/notify` 找人並提醒。
  - `fetchHistory` 參考最近活動；`registerCommand` 手動補登。
  - `secrets` 串 timesheet API；`sharedDataDir` 保存 user-project mapping 與去重紀錄。
  - `subagent.run` 可從工作敘述建議 project code，但最後由人確認。
- **為什麼 bash/edit/write 不適合**：這需要每天針對多位使用者持續發送、追蹤回覆、重試與寫入外部 SaaS；用 agent 工具會造成大量不必要模型 run，也可能把某客戶資訊帶進另一客戶上下文。
- **【API 缺口】**：
  - `listUsers` 缺少 email、manager、timezone、employment status 等排程與身份 mapping 所需欄位。
  - 沒有 user activity/conversation participation query；逐頻道抓 history 不實際且有隱私風險。
  - `openDm` 接受 user id，但跨平台／跨 workspace 的 identity linking 沒有標準模型。

### 5.3 Multi-client Brand & Data Boundary Guard

- **需求**：每個客戶 conversation 套用不同品牌語氣、禁用詞、法務 disclaimer 與資料邊界；阻止 agent 把 A 客戶名稱、檔案路徑或機密帶入 B 客戶頻道，並記錄違規趨勢。
- **觸發方式**：所有 agent run 與 tool calls/results；每月 compliance 報告。
- **使用 API**：
  - `on("before_agent_start")` 注入該客戶政策並掃描 prompt。
  - `on("context")` 檢查 transcript provenance。
  - `on("tool_call")` 阻擋讀取其他客戶路徑或危險外傳命令。
  - `on("tool_result")`、`on("message_end")` 遮罩敏感內容。
  - `paths.dataDir` 保存每 conversation policy；`sharedDataDir` 保存全域客戶索引。
  - `schedules` + `uploadFile/notify` 發 compliance 報告。
- **為什麼 bash/edit/write 不適合**：這是 agent 外層的政策執行器，必須在模型或工具接觸資料前生效。不能要求模型用自己的 bash 工具監督自己，也不能只靠 system prompt 保證 tenant isolation。
- **【API 缺口】**：
  - `api.context` 暴露 raw `conversationId`，但缺少穩定的 organization/workspace/customer tenant metadata；extension 必須自行維護易錯 mapping。
  - hooks 沒有標準資料 provenance labels；只看到文字與工具 args，很難證明片段來自哪個 mount、附件或 conversation。
  - hook errors 預設 fail-open，不符合嚴格資料邊界需求。
  - `notify`、Block Kit、upload、subagent output 沒有共用 policy interception seam，容易出現旁路。

---

## 跨組織反覆出現的 API 缺口（優先級觀察）

### P0：事件驅動平台整合

目前 extension hooks 主要圍繞 agent run。企業 extension 最常需要的是不依賴模型 run 的平台事件：

- message created/edited/deleted
- reaction added/removed
- thread reply created
- member joined/left、role changed
- channel/conversation created、archived、membership changed
- GitHub PR/issue/review/status/deployment webhook

若只能用 `fetchHistory` 輪詢，extension 必須自行處理 watermark、刪改、rate limit、重試與漏事件，可靠性會快速惡化。

### P0：身份、權限與 conversation metadata

`listUsers()` 與 `userId` 足以做通知，不足以做企業授權。反覆需要：

- workspace/organization id 與 conversation metadata
- conversation members
- user email、timezone、manager（可配置 disclosure）
- Slack user groups、Discord roles、GitHub teams
- 外部訪客／Slack Connect 身分
- extension 可查詢的「此人是否有某角色」能力，而非把整份敏感 directory 暴露出去

### P1：跨平台互動元件

`blockkit` 是實用能力，但 Slack-only。多平台產品需要較小、可移植的抽象，例如：

- buttons、single/multi select、confirm
- modal/form、validated fields、date/time picker
- interaction response/update/disable

不必完整抹平各平台；可以先提供 capability-based portable subset，再保留 Slack-native escape hatch。

### P1：安全與稽核 seam

企業 guardrail 需要：

- 可宣告 fail-closed 的 critical hook
- extension outbound 的統一 policy hook（`notify`、blocks、uploads、triggered runs、subagent結果）
- append-only audit event sink
- policy decision metadata 與 correlation/run id
- secrets 除 read-only value 外，最好可有 scoped outbound credential/proxy，降低 extension 直接持有 token 的風險

### P1：可靠 workflow primitives

`schedules` 已能支撐很多流程，但實務上還會需要：

- 收到特定 bot message/thread 回覆時喚醒 callback
- schedule group/cancel-all 與 workflow correlation id
- callback retry policy、dead-letter、最後錯誤與執行紀錄
- idempotency helper／host transaction 或 lock（尤其 `sharedDataDir`）
- extension 級 concurrency、rate limit 與 subagent cost budget

### P2：Messaging 與檔案 API 一致性

常見小缺口會增加大量 adapter-specific code：

- `notify` 支援 update/delete、metadata、ephemeral message
- `blockkit.post/update` 可指定 conversation/platform/thread
- `react` 可指定其他 conversation，並支援 remove
- `uploadFile` 可指定 conversation/thread、接受 stream/buffer、回傳 file id/URL
- history 提供穩定 cursor、message subtype、edit/delete 狀態、attachments metadata

---

## 使用者視角結論

現有 API 已足以做「command + schedule + text notification + Slack interaction + isolated subagent」型 extension，尤其適合投票、提醒、定期報告與人工觸發的工作流。真正進入企業日常後，最先碰到的不是更多 agent 工具，而是三個產品化問題：

1. **如何在沒有 agent run 時可靠接住平台事件。**
2. **如何知道誰有權做什麼，以及目前是哪個 workspace／客戶／conversation。**
3. **如何讓安全、稽核、重試與跨平台互動成為 host 保證，而不是每個 extension 自己重做。**

這些能力補齊後，extension 才能從「會跑的客製腳本」升級成企業敢長期依賴的整合應用。
