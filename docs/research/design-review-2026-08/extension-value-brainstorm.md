# Extension 值不值得:四視角腦力激盪綜合(2026-08-26)

四個 pi agent 獨立作答:企業使用者代言人(user)、極限懷疑者(skeptic)、
平台生態史學家(history)、agent 能力架構師(architect)。原始報告同目錄
`extension-brainstorm-{user,skeptic,history,architect}.md`。

## 出乎意料的收斂

四個立場迥異的視角,在三件事上獨立達成一致:

1. **In-process = deployment-trusted,不要假裝是生態安全。**懷疑者以此
   攻擊、史學家以 WordPress 為鑑、架構師據此設計 credential handle、
   使用者代言人要求 audit seam——全部指向 ADR 0006 主張 6 的誠實聲明
   是對的,且必須守住。
2. **同步 policy hooks 是不可替代的核心。**連懷疑者的「最後讓步」都承認:
   pre-execution veto(tool_call block/rewrite)無法用 webhook(非同步)、
   MCP(agent 主動呼叫,非強制)、skills(非安全控制)替代。這是
   extension 唯一無爭議的地盤。
3. **價值不在 marketplace,在「內部應用 SDK」。**史學家的野心水位、
   懷疑者的「trusted deployment plugins」、使用者的 5 組織 15 案例
   全部落在同一水位:5–20 個有 owner、可審 code 的 extensions,
   讓小團隊用幾百行 code 把工作流做成 conversation-native app。

## 懷疑者的有效攻擊(需要吸收)

- **分流判準**:「extension 可以做」不等於「該用 extension 做」。四問:
  需要攔截同步生命週期嗎?需要 host 端平台身分嗎?有同交易正確性要求嗎?
  移出 process 失去什麼?全否 → skills/MCP/外部服務。
- **API surface 停止線**:每加一個 host method 就是永久維護承諾。
  從真實 extension 需求反推 API,不要複製其他平台的功能清單
  (史學家第 5 誡相同)。
- **agent-pm 的裁決**:它已是需要自己 tenancy/storage/scheduler 的
  application——它是 service activation 需求的證據,不是現有模型的
  成功案例。與 tenancy 評審的結論互相印證。

## 使用者視角的需求地圖(15 案例的缺口統計)

現有 API 已足夠:command + schedule + notify + Slack interaction +
isolated subagent 型工作流(投票、提醒、定期報告、人工觸發流程)。

反覆出現的缺口,按頻率:

- **P0 平台事件驅動**:沒有 agent run 時接住 reaction/join/message 事件
  (現在只有 schedule 和 command 兩個喚醒源)
- **P0 身分與權限**:「此人有某角色嗎」的查詢面,而非傾倒整份 directory
- **P1 可移植互動元件**:blockkit 是 Slack-only;buttons/select/confirm
  的可移植子集
- **P1 治理 seam**:fail-closed hook 宣告、outbound policy、audit sink
- **P1 workflow 可靠性**:retry、idempotency、shared-state lock

## 架構師的控制面四缺口(與使用者 P1 治理重疊)

1. `ExtensionExecutionContext`:principal/tenant/run provenance 進 handler
2. Policy decision metadata + per-hook fail-open/closed 宣告
3. Durable operation API(retry/idempotency)
4. **Credential handles**:`api.credentials.withToken(name, fn)` /
   `api.kms.sign(...)` 取代 raw string secret——連 extension code 被攻陷
   都拿不到可匯出的 key。這是 vault-key 病灶的終極解。

## 對 ADR 0006 的修正輸入

1. 洩壓閥(pressure-release valve)是動機之一,不是全部。Extension 存在
   理由三類:①中介受限資源(閥)②model 不該參與的確定性行為(poll)
   ③治理與觀測(audit hooks)。現有 ADR 的 valve 節需擴為三類。
2. Vault 張力要講清楚:git token 進 sandbox 是核心價值主張的受權衡風險;
   Slack key 進 sandbox 是繞過已有中介面。判準是「有無被中介的路」,
   不是「credential 一律不進 sandbox」。
3. 新增「非目標」節:不是 marketplace、不是 iPaaS、不是 serverless
   platform;是自架 chat agent 的內部應用 SDK + core 的試驗田。
4. 分流判準(懷疑者四問)值得收進 ADR 作為「什麼時候不該寫 extension」。

## 結語

Extension 值得投資,但值得的是「窄而深」:同步 policy seam + 統一
跨平台 conversation 能力 + 受控 effects。不值得的是「廣而淺」:
更多便利 method、marketplace 幻想、通用 workflow 引擎。
