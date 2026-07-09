# mikan agent harness

mikan 自有的 agent harness 層。原先 mikan 依賴 `@earendil-works/pi-coding-agent`
（`AgentSession`、`SessionManager`、`ModelRegistry`、`AuthStorage`），但那是為單人
TUI 打造的完整產品；mikan 只用到其中一小部分，且 chat-bot 的多會話、headless、
多平台場景與 TUI 的假設漸行漸遠。本模組保留 pi-coding-agent 的核心精神
（append-only session tree、compaction、skills、extension hooks），改為直接站在
`@earendil-works/pi-agent-core`（agent loop、compaction 演算法、context 建構）與
`@earendil-works/pi-ai`（providers、models、auth 解析、串流）之上。

## 架構

```
┌────────────────────────────────────────────────────────────┐
│ mikan adapters / runtime / commands / web                  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ src/harness  (this module)                                 │
│                                                            │
│  MikanAgentSession (runner.ts)                             │
│    · prompt / subscribe / abort / reloadFromSession        │
│    · message persistence on message_end                    │
│    · auto-compaction (threshold + overflow recovery)       │
│    · auto-retry with exponential backoff                   │
│    · budget circuit breakers (token/cost/time/call caps)   │
│    · extension hook dispatch                               │
│                                                            │
│  SessionStore (session-store.ts)   MikanModels (models.ts) │
│    · v3 JSONL, append-only tree      · pi-ai Models 集合    │
│    · buildSessionContext             · models.json 自訂供應 │
│                                      · auth.json 憑證      │
│  Skills (skills.ts)                FileCredentialStore     │
│  Extensions (extensions/)          Settings (settings.ts)  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ pi-agent-core: Agent loop, compaction, buildSessionContext │
│ pi-ai: providers, Models, auth resolution, streaming       │
└────────────────────────────────────────────────────────────┘
```

### 模組職責

| 模組                              | 職責                                                                 | 取代的 pi-coding-agent API                    |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| `runner.ts` `MikanAgentSession`   | 回合迴圈：持久化、auto-compaction、auto-retry、預算熔斷、事件、extension hooks | `AgentSession`                                |
| `session-store.ts` `SessionStore` | v3 JSONL session tree 的同步讀寫                                     | `SessionManager`                              |
| `models.ts` `MikanModels`         | 模型目錄 + auth 解析（含 models.json 自訂供應商）                    | `ModelRegistry`                               |
| `auth.ts` `FileCredentialStore`   | `~/.mikan/auth.json` 憑證儲存（pi-ai `CredentialStore` 實作）        | `AuthStorage`                                 |
| `skills.ts`                       | SKILL.md 探索與 system prompt 格式化                                 | `loadSkillsFromDir` / `formatSkillsForPrompt` |
| `http.ts`                         | 全域 fetch：proxy 支援（`HTTP_PROXY` 等）+ idle timeout              | `http-dispatcher`                             |
| `settings.ts`                     | compaction / retry 預設值                                            | `SettingsManager`                             |
| `extensions/`                     | mikan 自有 extension 系統                                            | `DefaultResourceLoader` 的 extension 載入     |

### 相容性

- **Session 檔案格式不變。** `SessionStore` 讀寫既有 v3 JSONL（`session` header 行 +
  帶 `id`/`parentId` 的 entries）。entry 形狀與 pi-agent-core 的 `SessionTreeEntry`
  結構相同，因此 pi-agent-core 的 `buildSessionContext` 與 compaction pipeline
  直接在這些 entries 上運作。舊 mikan 寫出的會話檔可無縫重開。
- **auth.json 格式不變，位置改為 `~/.mikan/auth.json`。** pi-ai 的 `Credential`
  型別即為現行 auth.json 的形狀；檔案內容可直接沿用，但不再讀 `~/.pi` 下的舊路徑。
- **models.json 子集。** `MikanModels` 讀 `~/.mikan/models.json`：
  帶 `models` 陣列的供應商成為自訂供應商
  （`api` 支援 anthropic-messages / openai-completions / openai-responses /
  azure-openai-responses / google-generative-ai / mistral-conversations）；
  只帶 `baseUrl`/`compat` 的項目覆寫內建供應商模型。
- **事件面不變。** `MikanAgentSession` 事件 = pi-agent-core `AgentEvent`
  passthrough + `compaction_start/_end` + `auto_retry_start/_end` +
  `budget_exceeded`，adapters 的渲染程式不需修改（新增的 `budget_exceeded`
  是額外事件，舊 handler 忽略即可）。

## 預算熔斷（circuit breakers）

LLM 無法可靠地自己決定何時該停（停機問題），所以失控的 run 必須由外部叫停。
`settings.ts` 的 `BudgetSettings` 定義單次 `prompt()` 的資源上限（token、成本 USD、
牆鐘時間、LLM 呼叫次數）；任一項超限就 abort 該 run 並發出 `budget_exceeded` 事件。

- **互動回合**逐則由人把關，預設不設上限（`DEFAULT_BUDGET_SETTINGS = {}`）。
- **自主 run（event / trigger）** 沒有人盯著迴圈，`agent.ts` 會傳入
  `DEFAULT_EVENT_BUDGET`（10 分鐘、50 次 LLM 呼叫、2 USD）作為 stop-loss。

上限在每次 assistant `message_end` 時累計檢查（可在回合中途 abort），並在
`handlePostRun` 擋掉「超限後又被 retry/compaction 續跑」的漏洞。

## Prompt cache 友善

pi-ai 對 Anthropic 會在整段 system prompt 結尾放單一 cache breakpoint——只要
system prompt 有任何位元變動，整個請求（含最貴的對話歷史）就 cache miss。因此
`agent.ts` 的 `buildSystemPrompt` 只放**同一會話中穩定**的內容；每回合會變的
內容（event-trigger 模式、attribution，後者在多人頻道會隨發言者每回合改變）改由
`buildTurnInstructions()` 隨 user message 遞送，讓 system prompt 位元穩定、cache 保溫。

### 與 pi-coding-agent 的行為差異

- 設定與憑證改放 `~/.mikan/`（`auth.json`、`models.json`）；不再讀取
  `~/.pi/` 下的任何路徑。
- pi extension（`.pi/extensions`）不再載入；由 mikan extension 系統取代（見下）。
- prompt template / `/skill:` 指令展開不在 harness 內（mikan 的指令由
  `src/commands/` 處理）。
- OAuth 登入流程尚未接線（憑證檔中已有的 OAuth token 仍會被 pi-ai 解析與刷新）。

## Extension 系統 v1

Extension 是 ES module，放在 **state dir**（host-only，永不掛進 sandbox）
的 `extensions/` 下：

```
~/.mikan/extensions/global/audit.mjs        # 所有會話
~/.mikan/extensions/<conversationId>/       # 單一會話
```

**安全模型：** extension 程式碼在 mikan 主程序內執行，權限等同 mikan 本體
（平台 token、vault、host 檔案系統）。安裝 extension 是管理員動作。因此
extension 目錄絕不能放在 workspace 下 — image 模式會把 workspace/會話目錄
掛進 sandbox container，sandbox 內寫入的程式碼若被 host 載入即構成逃逸。
`global` 為保留字，平台的 conversation id 不會取此值。

匯出 `activate`（default 或具名皆可）：

```js
// extensions/audit.mjs
export default function activate(api) {
  api.on("tool_call", ({ toolName, args }) => {
    if (toolName === "bash" && String(args.command).includes("curl")) {
      return { block: true, reason: "network access is audited" };
    }
  });
  api.registerTool(myCustomTool);
  api.log("audit extension ready");
}
```

### Hooks（v1）

| Hook                 | 時機                      | 回傳值                                       |
| -------------------- | ------------------------- | -------------------------------------------- |
| `before_agent_start` | 使用者 prompt 送出前      | `{ systemPrompt? }` 覆寫本回合 system prompt |
| `tool_call`          | 工具執行前                | `{ block?, reason? }` 阻擋工具               |
| `tool_result`        | 工具執行後（觀察）        | —                                            |
| `message_end`        | 每則訊息完成（觀察）      | —                                            |
| `turn_end`           | 回合結束（觀察）          | —                                            |
| `session_compact`    | compaction 寫入後（觀察） | —                                            |

語意：註冊順序執行；有回傳值的 hook 以第一個非 `undefined` 結果為準；handler
擲錯只記 log，不會中斷回合。v2 計畫：`tool_result` patch、自訂 slash command
貢獻點、provider 註冊、session entry 貢獻（`appendCustomEntry` 已可由
`SessionStore` 直接使用）。

## 測試

- `test/harness-session-store.test.ts` — v3 格式相容、tree/branch、compaction 展開
- `test/harness-runner.test.ts` — faux provider 端對端：持久化、工具、hook 阻擋、auth 預檢
- `test/harness-extensions.test.ts` — loader 與 hook registry
- `test/harness-skills.test.ts` — SKILL.md 探索與 prompt 格式化
- `test/harness-auth.test.ts` — auth.json 讀寫
