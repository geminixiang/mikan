# mikan extension 作為受控能力擴充口：Agent 能力架構推演

## 核心判斷

如果把 mikan 的邊界明確定義為：

- **agent 是不受信任的意圖產生器**：可以讀寫 sandbox 允許的檔案、提出工具呼叫，但不能直接持有 production credential；
- **extension 是 host 內受信任、可審查、可撤銷的 capability provider**：它把高權限系統縮成窄、具型別、具政策的操作；
- **hook 是 policy enforcement point**：在 prompt、context、tool call、tool result、run settlement 各階段執行治理；
- **subagent 是隔離的認知工作單元**：不是 credential carrier，也不是無限制遞迴 agent；

那麼 extension 不只是 plugin 機制，而會成為 mikan 的 **capability control plane**。模型只能表達「我要查詢／申請／觸發某個效果」，真正的授權、credential、資料最小化、審計與副作用都由 extension 決定。

這個架構比「把 API key 放進 vault，再讓 bash/curl 自由使用」更接近 object-capability security：能力由可呼叫的窄介面表示，不由可複製、可外洩、可任意重組的 bearer secret 表示。

---

## (a) Custom tool：model 能請求效果，但拿不到 credential

### 1. 內部客戶／訂單／事故 API 查詢

**工具形狀**

```ts
customer_lookup({ customerId, fields: ["plan", "renewalDate", "accountOwner"] });
incident_status({ incidentId });
```

extension 在 host 端持有 CRM、ERP、PagerDuty 或內部 gateway credential。工具 schema 只允許固定 identifier 與欄位白名單；回傳前再依 conversation、user、tenant 做 row/field-level filtering。

**解鎖場景**

- Slack 中回答「C123 客戶何時續約？」
- 支援頻道查某張訂單的配送狀態，但不暴露付款資訊
- incident room 查服務狀態、owner、runbook 與目前 severity

**為何優於 vault + bash/curl**

- bash 拿到 token 後可呼叫 API 的任何 endpoint；custom tool 只能執行允許的 query。
- credential 不會出現在環境、命令列、shell history、錯誤輸出或 model context。
- extension 可固定 tenant routing，防止模型把 A tenant 的 ID 拿去 B tenant endpoint 查詢。
- 可在回傳前移除 PII、token、內部備註，而不是期待模型自行遵守。
- 每次呼叫可產生結構化 audit event：誰、在哪個 conversation、查了哪個 entity、回傳哪些欄位。

**現有 API 是否足夠**：`registerTool(AgentTool)` 足以做基本版本；`api.secrets` 可讓 extension 讀 credential，`RunOrigin.userId` 可供 `tool_call` hook 做部分政策判斷。

**主要缺口**：tool handler 本身沒有標準化的 caller/tenant/request context。extension tool 若要做 user-level authorization，不能可靠地從 `AgentTool.execute` 取得 `RunOrigin`；靠另一個 hook 旁路關聯 `toolCallId` 很脆弱。

---

### 2. 審批流：付款、權限、部署、資料匯出

**工具形狀**

```ts
request_payment_approval({ invoiceId, amount, reason });
request_access({ system, role, duration, justification });
```

工具不直接完成高風險動作，而是建立 pending request。extension 使用 `blockkit.post/onAction` 發送核准卡片給正確 approver；核准後由 host callback 執行，拒絕／逾時則終止。

**解鎖場景**

- agent 整理發票資料後提出付款申請
- agent 建議給 on-call 臨時 production read access，主管按鈕核准 2 小時
- agent 準備資料匯出，但 DPO／資料 owner 核准後才產生下載

**為何優於 vault + bash/curl**

- secret + bash 通常把「提出意圖」與「執行副作用」合併；extension 可以強制 two-person rule。
- 模型無法偽造按鈕 action；互動由 platform provenance 與 extension action namespace 路由。
- 可以把 request snapshot、approver、policy version、decision timestamp 一起保存，形成可重放的決策證據。
- 可限制金額、角色、有效期等 domain invariants，不讓模型自由組 endpoint payload。
- credential 只在核准後的 deterministic callback 使用，不進 model loop。

**現有 API 是否足夠**：`registerTool`、`blockkit.post/update/onAction`、`notify/openDm`、`paths.dataDir/sharedDataDir`、callback schedule（逾時）已能做出單平台基本審批流。

**主要缺口**：缺少正式的 durable workflow／transaction API、idempotency key、action authentication assurance、approver group/role lookup，以及「核准後執行」的 durable job queue。現在 extension 必須自行用 JSON/DB、lock、schedule callback 拼裝狀態機。

---

### 3. 資料庫唯讀與受限分析

**工具形狀**

```ts
sales_metrics({ tenantId, range, dimensions, filters });
lookup_deployment({ service, environment });
```

不要提供 `sql(query)`；extension 提供 domain query，或最多接受受驗證的 query AST／預先註冊 query ID。host 使用 read-only DB principal、statement timeout、row limit、tenant predicate 與欄位 allowlist。

**解鎖場景**

- 「比較本週與上週各方案轉換率」
- 「列出 production 中仍跑舊 image digest 的服務」
- 「找出這個 ticket 對應的最近五次 webhook delivery」

**為何優於 vault + bash/psql**

- read-only DB password 仍可能讀完整資料庫；custom tool 可限制到特定 view、tenant、欄位與 aggregation。
- 強制 timeout、cost ceiling、row cap，避免模型產生昂貴 full scan。
- 結果可以在 host 端先 aggregate／去識別化，模型只看到回答所需資料。
- 阻止 schema enumeration、系統 catalog 探測、資料批量 exfiltration。
- query 名稱與參數可被 audit；自由 SQL 很難做可靠政策判斷。

**現有 API是否足夠**：基本 custom tool 足夠；extension 可自行帶 DB client 與 read-only credential。

**主要缺口**：沒有 host 提供的 egress policy、query budget、結果大小上限、敏感欄位標記或統一 audit sink。每個 extension 都必須自己正確實作 timeout、redaction 與 tenant filter，容易漂移。

---

### 4. 觸發 CI/CD，但不能任意操控 GitHub token

**工具形狀**

```ts
trigger_ci({ repository, workflow: "integration-test", ref, inputs });
request_deploy({ service, environment, artifactDigest, changeId });
```

extension 只允許白名單 repository/workflow/environment，驗證 ref、artifact digest 與 change ticket；production deploy 可以轉入上例的審批流。

**解鎖場景**

- agent 修完程式後觸發特定 integration workflow
- 在 incident channel 對已批准 artifact 觸發 rollback workflow
- 查 workflow 狀態，完成時由 schedule/callback 主動通知 thread

**為何優於 vault + `gh`/curl**

- GitHub token 通常能讀 repo、改 workflow、建立 release、操作其他 refs；custom tool 只暴露 dispatch 某些 workflow。
- 防止模型透過 workflow inputs 注入 shell 或選擇惡意 ref。
- extension 可綁定 immutable SHA/digest，而不是接受模糊 branch 名稱。
- 可強制 environment policy、change window、approver 與 concurrency lock。
- credential rotation 不影響 tool contract，模型也永遠看不到 token。

**現有 API 是否足夠**：`registerTool` 可觸發；`schedules`、`notify`、`react` 可追蹤與回報；`blockkit` 可審批。

**主要缺口**：缺 durable async operation handle／job lifecycle。tool 最好能回 `{operationId, status:"queued"}`，之後由統一 API 更新原 tool/run/thread；目前要靠 extension 自建 polling schedule 與 message mapping。

---

### 5. 秘密材料的「使用」而非「讀取」：簽章、解密、臨時憑證

**工具形狀**

```ts
sign_release_attestation({ artifactDigest, provenance });
decrypt_for_validation({ ciphertextRef });
issue_ephemeral_db_access({ purpose, ttlSeconds });
```

最理想情況下，extension 甚至不讀出 private key，而是呼叫 KMS/HSM/STS；model 只得到 signature、驗證結論或短期受限結果。

**解鎖場景**

- 對已建置 artifact 簽 provenance
- 驗證加密設定是否符合 schema，但不把 plaintext 放入 workspace
- 發一組只能查某個 tenant view、10 分鐘後失效的臨時 capability

**為何優於 vault + bash**

- vault 若回傳 raw secret，agent 可複製、編碼、上傳或寫入 artifact；「sign」工具只允許 key usage，不能匯出 key。
- KMS policy、key purpose、digest 格式、TTL 可由 host 強制。
- tool result 可只回成功證明，不回敏感 plaintext。
- 可做 rate limit、human approval 與 non-exportable key audit。

**現有 API 是否足夠**：`registerTool` 能包 KMS；但現有 `api.secrets.get()` 本身仍是 raw-secret API，只是 secret 不直接給 model。extension 程式碼若被攻陷仍可讀出。

**主要缺口**：需要更高階的 host-managed secret operations，例如 `api.credentials.withToken(name, fn)`、`api.kms.sign(...)`、OAuth connection handle，而不是所有整合都降級成字串 secret。

---

## (b) Hooks 能解鎖的治理、合規與成本控制

### `tool_call`：副作用前的 Policy Enforcement Point

可做：

1. **命令／路徑政策**：阻擋 `bash` 對 production endpoint、危險 command、workspace 外路徑或特定檔案的存取。
2. **資料外洩防護**：檢查 tool args 是否含 token、PII、客戶資料；阻擋上傳到未核准 domain。
3. **變更管理**：production deploy、delete、permission change 若沒有 change ID／approval token 就 block。
4. **每人／每 tenant 權限**：同一 custom tool 對 on-call、developer、external guest 開放不同 operation。
5. **成本守門**：阻擋高成本 subagent/tool、過大 DB query、過頻繁 API operation。

**現有能力**：能看到 `toolName`、`args`、`origin.userId/platform/conversation`，並 block + reason，基本 admission control 足夠。

**缺口**：

- 只能 allow/block，不能安全地 **rewrite args**、要求 confirmation、轉成 approval pending、或附 policy decision metadata。
- 沒有 extension/tool owner、tool risk class、credential scope 等 metadata；政策只能靠工具名稱字串。
- hook errors 被吞掉且繼續，對 security policy 可能需要 per-hook fail-open/fail-closed 宣告。
- 缺組織角色、tenant claims、channel classification 等 normalized principal/context。
- 缺統一 audit emit API 與 policy decision ID。

### `before_agent_start`：run admission、prompt policy、資料分類

可做：

1. **敏感請求阻擋**：external tenant 要求查內部資料、法律保留資料、未成年／醫療資料時，在 model call 前阻擋。
2. **用途與同意檢查**：沒有 ticket、case ID、合法處理目的時，不允許啟動含客戶資料的 run。
3. **模型前路由**：注入 tenant policy、資料保存規則、可用能力說明；或把 prompt rewrite 成最小必要任務。
4. **prompt injection 防護**：對附件／貼入內容標記 untrusted data，加入不可授權外部指令的 system policy。
5. **成本 admission**：低優先頻道、超額 tenant、非工作時間的 autonomous run 可直接 block。

**現有能力**：可讀／改 `prompt`、`systemPrompt`、images，能 block，且 block merge 為 any-deny，適合基本 policy gate。

**缺口**：

- 看不到完整 tenant plan、quota、conversation classification、extension inventory、預估 token/cost、所選 model 的治理標籤。
- 不能回傳「改用某 model／thinking level／budget」；只能改 prompt 或 block。
- reason 是 user-facing 字串，缺 machine-readable policy code、remediation、audit details。
- 沒有互動式 confirmation／approval continuation primitive。

### `context`：送給模型前的資料最小化與合規視圖

可做：

1. **PII/secret redaction**：canonical transcript 保留原文，但本次送模型的 clone 移除信用卡、token、個資。
2. **資料駐留策略**：外部模型只收到摘要；敏感原文保留在 host 或只送核准 provider。
3. **最小必要 context**：按 tenant/user/tool scope 移除無關 thread、舊附件與其他客戶識別資訊。
4. **legal hold／retention view**：被標記不可用於推理的內容從 model context 排除，但不竄改持久紀錄。
5. **成本壓縮**：在送模型前以 deterministic rule 去重 log、截斷巨大 tool result、保留 decisions 而非全部過程。

**現有能力**：call-local clone 與 chaining 很適合 redaction/minimization，不污染 canonical transcript。

**缺口**：

- `AgentMessage[]` 缺 provenance/classification labels，extension 只能猜哪些段落來自 tool、attachment、哪個 tenant/resource。
- 沒有 provider/model target 與 data-processing attributes，無法按 residency/SLA 精準決策。
- 沒有「opaque reference」內容類型：敏感資料只能刪掉或用文字 placeholder，不能讓特定受控 tool 後續按 handle 取用。
- 多 extension rewrite 沒有可觀測 diff/audit trail。

### 其他現有 hooks 的延伸價值

- **`tool_result`**：在模型看到結果前遮蔽 secret、裁切 rows、替換成 aggregate；也可把 tool usage 納入成本。現有 rewrite 能力很好，但缺 sensitivity metadata、max-size contract 與 host-level non-bypass guarantee。
- **`message_end`**：對最終回答做 DLP、法規 disclaimer、禁止輸出某些資料。現有 rewrite 足以做後處理，但若 hook 失敗預設繼續，不能當唯一強制防線。
- **`turn_end` / `agent_error` / `budget_exceeded`**：寫 audit、SLO、chargeback、通知 owner。現有事件適合 telemetry，但缺 run ID、session ID、tenant ID、完整 usage breakdown 與 structured outcome。
- **`session_compact`**：把合規必要的決策、approval reference、data classification 保留進摘要。現有事件偏通知，不能控制 compaction output，治理能力有限。

---

## (c) Subagent API 能做的編排

現有 `SubagentApi.run()` 的重要安全特性是：fresh context、預設無 tools、不可遞迴啟動 subagent、失敗以 terminal status 回傳。這使它適合當 **隔離的認知函式**，而不是另一個無限權限 agent。

### 可實作的編排模式

1. **Planner–executor（但 executor 是 deterministic extension）**
   - subagent 把需求轉成結構化 plan／query AST。
   - extension 驗證 schema、policy 與 budget。
   - extension custom tool 執行真正 API/DB 副作用。
   - 優點：模型負責語意理解，可信程式負責 authorization 與 effects。

2. **多專家並行分析**
   - 同時啟動 security、cost、compliance、domain 四個無工具 subagent。
   - extension 合併 structured outputs，只有全數符合或特定 quorum 才建立 approval request。
   - 適用 deployment review、供應商評估、incident hypothesis。

3. **資料分片／map-reduce**
   - extension 從受控 API 取得並去識別化資料，分片交給多個 subagent 摘要／分類。
   - 最後一個 subagent只看 partial summaries 做 reduce。
   - 原始 credential 與完整資料集不進任何單一 agent context。

4. **高低成本模型分層**
   - 低成本 subagent 做分類、抽取、去重；只有模糊或高風險 case 升級較強模型。
   - extension 根據 confidence、tenant plan 與剩餘 budget 決定 escalation。

5. **獨立 verifier／critic**
   - 主 agent 提出操作意圖；subagent只收到 policy、proposal 與必要證據，輸出 allow/deny/reasons schema。
   - extension 仍做最終 deterministic checks，verifier 不能自己執行工具。

6. **事件驅動長流程中的認知節點**
   - callback schedule 定期取得 CI 狀態；失敗時 subagent 分析 logs，產生摘要；extension notify thread。
   - 人類核准後再啟下一個 deterministic operation。

### 現有 API 足夠處

- 單次或 extension 自行 `Promise.all` 的並行 subagent。
- structured output schema、隔離 context、有限 contributed tools（由 extension 註冊的 tools）可支援 planner、extractor、critic。
- 結合 `schedules`、`notify`、`blockkit`、`paths` 可自建簡單 state machine。

### 缺口

1. **無 orchestration primitive**：沒有 DAG、fan-out limit、quorum、retry/backoff、deadline、cancellation、resume、durable operation ID。
2. **無 child budget contract 的 extension-facing保證**：需要明確 per-run token/cost/time cap、整體 workflow budget，以及 budget reservation，而不只是事後 usage。
3. **無能力衰減（capability attenuation）模型**：extension 應能給 subagent 一組明確、窄化、帶 scope 的 tool grants，而不是只靠「contributed tools」集合。
4. **缺 provenance**：結果應帶 model、prompt policy version、tool grants、parent run ID、tenant、input hashes，才能用於合規決策。
5. **缺 streaming/progress/cancel**：長分析無法原生回報進度、被使用者取消或在新訊息到來時中止。
6. **缺 durable workflow storage**：harness 重啟後，extension 必須自行重建等待中的多 agent 流程。

---

## (d) 現有 MikanExtensionApi 足夠與缺口總表

| 能力場景                       | 現有 API                                                    | 判斷                                   | 關鍵缺口                                                                   |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| 窄化 internal API tool         | `registerTool`, `secrets`                                   | **基本足夠**                           | tool execution caller context、tenant claims、audit sink                   |
| 唯讀 domain query              | `registerTool`, `tool_result`                               | **基本足夠，但安全責任全在 extension** | query budget、egress policy、classification、結果上限                      |
| CI trigger + 回報              | `registerTool`, `schedules`, `notify`, `react`              | **可做 MVP**                           | durable async operation、idempotency、job status API                       |
| 人工審批流                     | `blockkit`, `openDm`, `notify`, `paths`, callback schedules | **可拼裝**                             | durable workflow/transaction、role/group lookup、approval evidence         |
| KMS/sign/secret use            | `registerTool`, `secrets`                                   | **介面層級不足**                       | non-exportable credential handle、KMS/STS/OAuth operation API              |
| Tool admission policy          | `tool_call`                                                 | **allow/deny 足夠**                    | args rewrite、challenge/approval、risk metadata、fail-closed mode          |
| Run admission policy           | `before_agent_start`                                        | **基本足夠**                           | structured policy decision、model/budget override、tenant/quota context    |
| Context redaction/minimization | `context`                                                   | **機制足夠**                           | provenance/classification labels、provider residency metadata、opaque refs |
| Result redaction               | `tool_result`                                               | **機制足夠**                           | sensitivity contract、non-bypass guarantees、統一 limits                   |
| 最終輸出 DLP                   | `message_end`                                               | **可做輔助防線**                       | security hook fail-closed、structured violation handling                   |
| 成本/錯誤 telemetry            | `budget_exceeded`, `agent_error`, `turn_end`                | **部分足夠**                           | run/session/tenant IDs、完整 usage、audit/metrics API                      |
| 單次 isolated subagent         | `subagent.run`                                              | **足夠**                               | cancellation、progress、explicit grant/budget                              |
| 多步 durable agent workflow    | `subagent` + extension state/schedules                      | **不足，需大量自建**                   | DAG/workflow runtime、resume、retry、quorum、workflow budget               |
| Optional host integration      | `api.capabilities` / `mikan.requires`                       | **方向正確**                           | capability metadata/version/scope，不只 boolean availability               |
| Multi-tenant state             | `dataDir`, `sharedDataDir`, `context.conversationId`        | **local state 清楚**                   | normalized tenant identity、cross-tenant authorization、domain locks       |

---

## 建議新增的介面（依架構價值排序）

### 1. `ExtensionExecutionContext`：把 principal、tenant、run provenance 帶到 tool handler

這是最大缺口。custom tool 若沒有可靠 caller context，就只能做到「credential 不給 model」，做不到完整的「此人、此 tenant、此 conversation 是否可用此能力」。

建議每次 tool execution 都能取得：

```ts
interface ExtensionExecutionContext {
  runId: string;
  sessionId: string;
  office: { platform: string; conversationId: string; officeKey: string };
  principal?: { platformUserId: string; roles?: string[] };
  origin: RunOrigin;
  tenant?: { id: string; plan?: string; classifications?: string[] };
  abortSignal: AbortSignal;
  audit(event: ExtensionAuditEvent): void;
}
```

最好由 mikan 包裝 extension tool handler，而不是要求 extension 用 hook + global map 推導 context。

### 2. Structured policy decision + fail mode

讓 policy hook 可回：

```ts
{
  decision: ("deny" | "allow" | "require_approval", code, reason, metadata);
}
```

並在註冊時宣告 `failureMode: "closed" | "open"`、priority／policy class。安全 gate 不應與一般 UX hook 共用「throw 後 log and continue」語意。

### 3. Durable operation/workflow API

提供最小而非龐大的 orchestration engine：

- `operations.start/idempotent`
- durable status + result
- retry/backoff/deadline/cancel
- wait for human action or external callback
- schedule wake-up
- operation → conversation/thread mapping

這會把 CI、審批、長查詢、subagent workflow 從每個 extension 自建 JSON 狀態機，提升為一致的 host guarantee。

### 4. Credential handles，而非只有 raw secret strings

逐步補：OAuth connection reference、KMS sign/decrypt、STS exchange、`withCredential` callback。目標是 extension 也不必長時間持有可匯出的 bearer secret。

### 5. Capability contract 升級為帶 scope/version 的 grants

目前 boolean `has()` 適合 availability，不足以描述：

- 只允許目前 conversation，或可 cross-conversation；
- 只讀／可寫；
- 哪些 repositories、workflows、DB views；
- 每分鐘/每日 quota；
- capability contract version。

長期可演進成：

```ts
api.capabilities.get("messaging.notify");
// => { available: true, version: 1, scope: { crossConversation: false } }
```

但 domain authorization 仍應留在 custom tool／host service，不要把所有權限都塞進通用 capability 字串。

---

## 最終推演：這會解鎖什麼產品形態？

1. **企業內部 action agent**：能查資料、開 ticket、觸發 CI、發起審批，但沒有通用 production shell credential。
2. **可稽核的 agent app platform**：extension package 成為經 review 的 capability bundle；manifest 宣告需求，host 決定注入哪些能力。
3. **tenant-specific policy plane**：同一模型行為，在不同 office/tenant 由 hooks 套用不同資料、成本、工具與合規政策。
4. **human-in-the-loop automation**：模型負責理解與提案，Block Kit/commands 負責明確決策，deterministic callbacks 負責副作用。
5. **安全的 agent workflow runtime**：subagent 做隔離認知工作，extension 做 orchestration 與 effects，credential 永遠停留在受信任邊界。
6. **能力市集而不是 prompt 市集**：可安裝的不是「更多指令文字」，而是有 schema、權限、審計、tenant scope 與 lifecycle 的業務能力。

真正的架構分水嶺是：不要把 extension 當作替 agent 偷渡更大 shell 權限的方法；要把它當作 **把廣泛 credential 壓縮成窄 capability、把概率性意圖轉成可治理效果** 的地方。mikan 現有 `registerTool`、hooks、Block Kit、schedules、subagent 與 per-conversation paths 已經具備這個方向的骨架；下一階段最需要補的不是更多便利 method，而是 execution context、policy decision、durable operation、credential handle 這四個控制面介面。
