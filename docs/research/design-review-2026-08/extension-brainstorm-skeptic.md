# 極限懷疑者：為什麼 mikan 不該繼續投資 extension 系統

## 結論先行

最強的反對論點不是「extension 沒用」，而是：**它把少數部署客製需求，錯誤升格成一個需要長期維護的平台級產品面。**

mikan 是小型 multi-tenant 聊天 agent，不是通用應用伺服器、工作流引擎或 Slack app marketplace。現有 extension API 已經開始同時承擔：agent hooks、tools、commands、排程、祕密、檔案狀態、跨 conversation 訊息、歷史讀取、使用者查詢、Block Kit、reaction、upload、subagent、生命週期與 capability negotiation。這不是一個「小 escape hatch」，而是一個正在形成中的第二套 application platform。

但它最重要的承諾——隔離模型與原始 credential——並不要求 in-process extension。相反地，現有設計讓每個 extension 取得整個 mikan host process 的完整權限；capability declaration 只是相容性檢查，不是安全邊界。於是系統同時承擔了平台 API 的維護成本，卻沒有獲得真正第三方生態最需要的隔離、可撤銷權限與故障邊界。

如果團隊很小，最合理策略應是：**停止擴張 `MikanExtensionApi`，把大部分需求分流到 skills、MCP 與外部服務；只保留一個窄而明確的內部 trusted plugin seam，甚至直接稱為 deployment plugins，而不是 ecosystem。**

---

## 1. 先質疑需求分類：多數「extension 需求」根本不需要進 mikan process

判斷標準不該是「extension 可以做」，而應是：

1. 是否必須攔截 mikan 的內部同步生命週期？
2. 是否必須在 host 端代表 mikan 使用平台既有身分，且不能透過窄 RPC 表達？
3. 是否存在低延遲、同一交易內的正確性要求？
4. 若移到外部 process，究竟失去什麼不可替代的語義？

若答案都是否，in-process extension 就不是必要條件。

### 1.1 Skills / prompt 已能涵蓋的需求

適合 skills 或 prompt 的需求包括：

- 組織流程、回答風格、審查清單、術語與政策；
- 「遇到 X 時先讀 Y，再執行 Z」之類的 agent 操作規範；
- 對既有工具的編排，而非新增 host authority；
- 任務分解、輸出格式、領域知識、工作流說明；
- `agent-pm` 所謂 task triage、判斷規則、workflow prompts 等模型層行為。

這些內容最大的價值正是可檢視、可修改、低耦合，不需要版本化 TypeScript API。把它們包進 extension 只會增加安裝、activation、相容性與除錯成本。

### 1.2 MCP 已能涵蓋的需求

只要需求是「讓模型使用某個外部系統的受控能力」，MCP 通常是更自然的邊界：

- GitHub/Jira/Linear/Calendar/CRM 查詢與變更；
- 內部資料庫、搜尋、報表、工單；
- 有 schema 的 domain tools；
- 由另一個團隊維護、已有獨立授權模型的服務；
- 可接受 request/response 或 stream 語義的操作。

MCP 的優勢不是協定本身完美，而是它把服務生命週期、依賴、credential、資源限制與 crash 隔離在 mikan 外。第三方可以版本化自己的 server，而不是要求 mikan 穩定整個 `MikanExtensionApi`。

ADR 的核心案例是「不能讓模型拿 Slack raw token」。這只能證明需要**受控的 credential broker / semantic tool**，不能證明該 broker 必須是 in-process extension。外部 MCP server、sidecar 或內網服務一樣可以持有 token，只暴露 `post_reply(thread, text)`；而且被攻破時不會自動等於取得整個 mikan process。

### 1.3 外部獨立 bot / app 已能涵蓋的需求

以下需求本來就是平台 app，而不是 mikan extension：

- Slack poll、表單、審批、按鈕互動；
- 排程通知、heartbeat、on-call 提醒；
- repository/calendar/webhook ingest；
- task queue、workflow engine、跨 conversation 狀態；
- 大量 deterministic handlers，不需要模型的互動；
- 長期常駐、重試、dead-letter、去重與觀測需求。

`poll` 範例尤其暴露分類錯誤：它「零 LLM calls」、command 與按鈕都直接 deterministic dispatch。這其實是一個 Slack app feature，mikan 只因已經握有 Slack connection 而順便成為它的 app runtime。若每個不需要 agent 的 Slack 小工具都算 mikan extension，mikan 的產品邊界會無限膨脹。

`scheduled-counter` 也不是 extension 投資的有力證據。它展示的是 command + cron + JSON state；任何 webhook service、serverless function 或幾十行 bot 都能完成。為了讓 counter 成為「golden path」，mikan 反而必須永久維護 schedules、notify、state directory、activation、disposal、capabilities 與 dev tooling。

`agent-pm` 更接近反證。它已有 SQLite schema、事件管線、workflow、task、feedback、delivery dedup、schedule ownership、test/live routing，以及未來的 GitHub/calendar ingest。這是一個獨立產品或服務，被塞進 extension 後才出現 `controlConversationId` 充當假 owner、shared data concurrency 自行負責、cron polling latency、全域 secrets 等不自然問題。ADR 自己承認它需要尚未存在的 service activation。更直接的解法不是再擴充 activation model，而是承認它應該是外部 service。

---

## 2. 自有 Extension API 的成本遠高於表面程式碼

`MikanExtensionApi` 不是普通 internal interface。一旦告訴使用者「可以寫 extension」，它就成為產品承諾。

### 2.1 API 穩定性負債

目前 API 已暴露或間接承諾：

- hook 名稱、順序、rewrite/block/error semantics；
- `AgentTool`、`AgentMessage`、`Model<Api>`、`ThinkingLevel` 等上游 pi 型別；
- command precedence 與 dispatch 行為；
- disposer 時機與順序；
- conversation context identity；
- data/shared directory layout 與刪除語義；
- secrets resolution；
- schedule ownership、命名、持久性與 callback 行為；
- notify/openDm/history/users/Block Kit/reaction/upload；
- subagent request/output contract；
- manifest、slug、install precedence、capability names；
- 每 conversation activate 的生命週期。

這些任何一項改動都可能破壞使用者程式。更糟的是 API 直接引用 `@earendil-works/pi-agent-core` 與 `pi-ai` 型別，使 mikan 也替上游 API 演進背書。內部 harness 重構不再只是內部重構；它可能變成 extension breaking change。

### 2.2 相容性不是加一個 `capabilities.has()` 就解決

Capability negotiation 只能回答「這個 host 有沒有功能」，不能回答：

- 同名 capability 的語義是否改變；
- payload schema 的版本；
- callback 是否至少一次、最多一次或可能併發；
- platform 差異與 fallback；
- extension 需要的最低/最高 host 版本；
- API deprecation window；
- data migration；
- 一個 extension 升級失敗時如何 rollback；
- 多個 extension 對同一 hook/command/tool 的衝突。

`agent-pm` 還保留 `typeof api.schedules?.onCallback` 的手工版本檢查，正說明 capability contract 並未消除相容性負擔，只增加另一層機制。

### 2.3 文件、範例、測試矩陣會持續擴張

每個 API surface 至少需要：

- reference docs、概念 docs、migration notes；
- scaffold 與可運作範例；
- local dev 模擬器；
- 各平台行為與限制說明；
- unit/integration/e2e coverage；
- 錯誤訊息、診斷與 observability；
- 安裝、升級、移除、資料保留與 secrets rotation；
- tenancy 與 rollout 文件。

`poll` 已顯示 dev loop 無法測 Block Kit，Slack slash command 還受 app manifest 限制；也就是 extension dev experience 天生需要跨真實平台測試。每新增一個 capability，測試矩陣大致是 extension × platform × activation scope × sandbox/runtime mode × host version。

對小專案而言，真正成本不是寫出 `api.react()`，而是承諾它未來仍然可用、可理解、可遷移。

### 2.4 機會成本

投入 extension 平台的每一週，都不是投入：

- mikan 核心 agent reliability；
- sandbox isolation；
- session correctness；
- 各平台 adapter 品質；
- credential security；
- observability；
- 更標準的 MCP 或 webhook integration。

Extension 的成功還會反過來製造更多核心需求：marketplace、簽章、package provenance、permissions UI、版本解決、tenant activation、billing、resource quotas、background jobs、schema migrations。這是一條很難停下的產品路線。

---

## 3. In-process 全信任模型使「生態」幾乎是虛構的

ADR 很誠實：extension 可以直接 `import node:fs`，所以 API shape 不是 security boundary。這一點足以推翻「第三方 ecosystem」敘事。

### 3.1 管理員 vetting 等於把供應鏈審查外包給部署者

安裝 extension 的實際意思是：

> 允許作者的任意 Node.js 程式碼，以 mikan process 的 OS 權限執行，讀取 process 可見的檔案、環境變數、network、state、其他 tenant 資料，並可能干擾整個 bot。

這不是一般使用者理解的「安裝一個 poll plugin」，而接近「在 production server 執行第三方 npm package」。manifest 宣告 `requires: ["blockkit"]` 不會阻止程式讀 filesystem 或自行發 network request。

若管理員必須逐行審查、pin source、追蹤 transitive dependencies 並承擔全 host compromise，那可安全安裝的 extension 只剩：

- mikan 自己維護；
- 同一組織內受信任工程師維護；
- 少數經過人工安全審查的部署客製程式。

這可以叫「內部 plugin mechanism」，但很難誠實稱為 ecosystem。

### 3.2 Multi-tenant consent 在全信任 host code 面前很薄

Office owner 的 activation/consent 只能控制 mikan 是否正式把該 extension 綁到該 office。它無法阻止已載入 process 的惡意 extension 自行掃描其他 office state、vault、workspace 或 global data。也無法限制 CPU、memory、event-loop blocking、network egress。

因此 actors 表格中的「conversation owner trusts extension with that office's data」並不由技術邊界保證；deployment administrator 實際上是把 extension 信任到**所有 offices 與整個 host**。這與 multi-tenant 最小權限模型根本矛盾。

### 3.3 Fault isolation 也不存在

即使作者完全善意，extension 仍可能：

- blocking I/O 卡住 event loop；
- memory leak；
- 無界 timers/handles；
- process crash 或 native addon fault；
- monkey-patch global state；
- 產生未受控 network/file I/O；
- 與另一 extension 發生命名、資源或生命週期衝突。

「hook errors are logged and never crash a run」只包得住 handler promise 的普通錯誤，包不住 process-level 行為。當 extension 故障半徑等於整個 multi-tenant bot，生態規模越大，可靠性越差。

### 3.4 若最終仍需 out-of-process runtime，現在的投資可能只是過渡負債

ADR 將 out-of-process 延後到「第三方 code 成為需求」時。但第三方 ecosystem 恰恰是投資 extension 平台最常見的正當化理由。若現在只服務內部 trusted code，就不該先建成寬廣 public API；若未來要第三方，就應優先設計 process/RPC boundary，避免先讓所有 extension 耦合 host internals，再昂貴遷移。

---

## 4. 「保護 credential」的論證不足以支持整套 extension 平台

ADR 最強論點是：模型不應拿 raw Slack token，而應呼叫 host-side semantic capability。這個安全目標正確，但推論過度。

真正需求是：

- credential 不進 model/sandbox；
- operation 是窄而有 schema 的；
- tenant、actor、target 與 audit context 明確；
- policy 可在執行前檢查；
- credential 可 rotation/revoke；
- 執行服務可隔離與限流。

這些需求更自然地導向 capability broker、outbound gateway 或外部 integration service，而不是任意 in-process JavaScript。

甚至就現況而言，extension 只是防止**模型**直接拿 credential，卻把 credential 周圍的安全問題轉交給一段擁有 host 全權的程式。這比 `bash + raw token` 好，但不是可擴張的 plugin security model。

---

## 5. 更便宜的替代架構

### 5.1 最小 outbound webhook

mikan 提供一個窄的 event sink：

- `message.received`
- `agent.run.completed`
- `tool.requested`（僅可觀察或對少數操作作 policy decision）
- `conversation.lifecycle`
- `interaction.received`

事件包含簽章、office identity、platform metadata、trace id，但不含不必要的 tenant 資料。外部服務非同步處理。

優點：

- mikan 只維護 versioned event envelope；
- 外部服務可用任何語言、獨立部署、重試與監控；
- extension crash 不拖垮 mikan；
- webhook receiver 可按 tenant 自行管理。

### 5.2 窄 inbound Actions API

外部服務透過 service credential 呼叫：

- `POST /offices/{id}/messages`
- `POST /offices/{id}/agent-runs`
- `POST /offices/{id}/reactions`
- `POST /offices/{id}/files`
- 必要時的 interaction update endpoint

每個 token 綁定 deployment/office/action scopes；mikan 做平台語義、稽核與 rate limiting。這直接保留 ADR 想要的「credential 不給模型」與「平台 semantics 不被繞過」，但不需要執行第三方 code。

### 5.3 Interaction callback URL

對 Block Kit 類需求，mikan 可以只提供 routing gateway：

- 外部服務要求 mikan 發出已 namespaced 的互動訊息；
- click 由 mikan 驗證、正規化後 POST 到 extension service callback；
- service 回傳 update/respond action；
- callback 有 timeout、重試、idempotency key。

這比把 poll code載入 mikan process 更接近 Slack 自己成熟的 app model。

### 5.4 MCP / tool server

Agent-facing integrations 直接使用 MCP。mikan 要做的是：

- per-office server activation；
- secret binding；
- tool allowlist；
- audit；
- timeout/resource policy；
- schema/version discovery。

這比自有 `registerTool` ecosystem 更可攜，也避免 extension 型別直接耦合 pi internals。

### 5.5 Sidecar integration runner

若 webhook/MCP 不足，可以提供一個獨立 integration runner process：

- 與 mikan 透過 Unix socket/localhost RPC；
- 每 extension 獨立 process 或至少獨立 worker；
- 明確 capability token；
- 無 mikan filesystem access；
- CPU/memory/time limits；
- process crash 自動重啟；
- versioned protocol。

它仍有平台成本，但至少成本買到了安全與故障隔離，而不是只買到方便 `import`。

### 5.6 甚至更便宜：不做通用框架

對 mikan 自己確定需要的少數能力，直接做成核心 feature 或 adapter feature：

- 安全的 platform reply tool；
- schedule；
- Block Kit primitives；
- audited notification API。

若只有兩三個內部 consumers，直接、明確的核心功能通常比一套通用 extension SDK 更便宜。不要為了避免「hard-code」而創造一個更昂貴的平台。

---

## 6. 對現有三個範例的懷疑性裁決

| 範例                | 最便宜的合理實作                                                               | 是否證明需要 in-process extension                                                                      |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `scheduled-counter` | 外部 cron + KV/SQLite + inbound message API；甚至只是核心 schedule demo        | 否。需求過小，不足以支付 extension platform 成本                                                       |
| `poll`              | 獨立 Slack app，或 interaction callback service 經 mikan gateway               | 否。完全不使用 LLM，分類上更像 platform app                                                            |
| `agent-pm`          | 獨立 workflow/task service，以 webhook ingest、MCP tools、inbound actions 串接 | 反而證明不該。它已經是一個需要自己 tenancy、storage、scheduler、delivery、observability 的 application |

三個範例共同證明「API 很能做事」，沒有證明「讓這些事在 mikan process 做，是成本最低或安全性最佳的邊界」。

---

## 7. 建議的停止線

若接受懷疑者立場，應立即設定：

1. 不再增加一般性 `MikanExtensionApi` surface。
2. 不承諾第三方 marketplace 或穩定 ecosystem。
3. 將 extension 明確改稱「trusted deployment plugins」。
4. 標註 API experimental、只保證同一 minor line 或乾脆不保證跨版。
5. 優先推出 webhook + scoped inbound actions，將新整合導向 out-of-process。
6. Agent-facing tools 優先走 MCP。
7. deterministic platform app 優先走外部 bot/callback。
8. 僅核心必須同步介入的 hooks 保留 in-process。
9. 不繼續替 shared state、service activation、通用 job runtime 擴建 extension 平台；那是在重造 application server。

---

## 8. 如果必須讓步：extension 唯一站得住腳的核心用途

唯一真正難被 skills、MCP、webhook 或外部 bot 完整替代的核心用途是：

> **由 deployment administrator 親自審查並維護的、低數量、高信任、需要同步介入 mikan agent run 內部生命週期的 policy hooks。**

典型例子：

- 在 tool call 執行前同步 block 或 rewrite；
- 在 agent start/context/tool result/message end 階段修改 run；
- 注入與當前 harness 深度耦合、無法合理 RPC 化的本地 tool；
- 部署特有的 audit/compliance enforcement，必須與一次 run 同步成功或失敗。

這一用途成立，是因為 webhook 的非同步延遲無法做 pre-execution veto，MCP 是 agent 主動呼叫而不是不可繞過的 host policy，skills/prompt 也不是安全控制。

但這個讓步同時大幅縮小了系統定位：

- 它不是第三方生態；
- 不是通用 app framework；
- 不是 workflow runtime；
- 不是平台 UI toolkit；
- 不是任意外部 integration 的首選。

它只是 **trusted synchronous host policy plugin seam**。若 mikan 以此為界，extension 仍有合理存在價值；若繼續向 schedules、state、cross-office apps、platform UI、messaging 與 service activation 擴張，就很可能是在用小專案的維護能力，承擔一個沒有真正安全邊界的應用平台。
