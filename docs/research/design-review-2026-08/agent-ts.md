# `src/agent.ts` 設計審查

審查範圍：`src/agent.ts` 全檔，以及 `PiAgentWrapper` 在 `src/types.ts` 的 interface。

審查依據：AGENTS.md 的 File-Split Scale（Slot / Authority / Weight）與「resource authority 一規則一家」。

不重複既有 findings：A1–A8 extensions findings、B3 profile registry 雙份傳遞（`agent.ts:1462-1477`）、B6 `getApiKeyForProvider`（`agent.ts:2146`）。

## 總結

`agent.ts` 並不是單純的 runner 組裝廠；它同時承擔 prompt policy、workspace path vocabulary、skill resolution、run presentation、telemetry、session maintenance 與 wrapper facade。合理的拆分尺度不是行數，而是以下 authority：

1. Prompt authority
2. Agent resource catalog
3. Execution binding
4. Run presenter
5. Conversation runner composition root

---

## Findings

### 1. Retry 成功後仍可能回傳舊的 `errorMessage`

- **Severity**：correctness — 高
- **位置**：`src/agent.ts:1917-1926,2375`

#### 問題

每個 assistant `message_end` 都更新 `stopReason`，但只有存在 `assistantMsg.errorMessage` 時才更新 `runState.errorMessage`。若第一次 provider call 失敗、runner 自動 retry 後成功，`stopReason` 會變成成功值，`errorMessage` 卻保留第一次失敗內容。`run()` 最後直接同時回傳兩者。

Runtime 因而可能收到：

```ts
{ stopReason: "stop", errorMessage: "503 Service Unavailable" }
```

成功 run 帶著錯誤狀態，呼叫端必須猜測哪個欄位才是 authority。

#### 最小修正方向

每次 assistant message 完成時，以目前 message 為 authority：

```ts
runState.errorMessage = assistantMsg.errorMessage;
```

更穩健的方向是不要累積這兩個欄位，而是在 run settle 後從最終 assistant message 一次產生 immutable outcome。

---

### 2. 一般 `run()` 沒有 `finally` 收回 runState ownership

- **Severity**：correctness — 高
- **位置**：`src/agent.ts:2232-2375`
- **對照**：`dreamSessionMemory` 已在 `src/agent.ts:2381-2447` 使用 `finally`

#### 問題

正常與 blocked 路徑會手動清除 `runState.responder`、`logCtx`、`queue`，但若以下任一操作 throw：

- `prepareRunContext`
- `session.prompt`
- response rendering
- usage reporting
- responder queue interaction

共享 `runState` 中的 presentation references 便會殘留。`dreamSessionMemory` 已用 `finally` 處理相同問題，兩條 run lifecycle 並不一致。

後續 session events 可能被送到上一個 responder；`getCurrentStep()` 也可能暴露失敗 run 的殘留工具狀態。

#### 最小修正方向

整個 `run()` 在完成必要 setup 後進入 `try/finally`。Finally 統一：

- 清除 progress timer
- detach responder/log context/queue
- 清除或封存 pending progress
- 取消目前 presentation 的 event ownership

Return outcome 應在 cleanup 前複製成 immutable value。

---

### 3. `RunnerSessionState` 混合三種不同生命週期的 state

- **Severity**：authority — 高
- **位置**：`src/agent.ts:707-740,752-808,1755-2087`

#### 問題

`RunnerSessionState` 同時包含：

1. **Run outcome**
   - `stopReason`
   - `errorMessage`
   - `totalUsage`
   - `llmCallCount`

2. **Platform presentation**
   - `responder`
   - `logCtx`
   - `queue`

3. **Streaming/progress state**
   - `pendingTools`
   - `toolProgress`
   - `subagentProgress`
   - `completedSubagentProgress`
   - `toolProgressTimer`
   - response suppression flags

三者被放在同一 mutable object，由 `resetRunState`、event subscriber、`run()`、finalizer 與 `getCurrentStep()` 共同寫入。沒有一個 module 擁有完整的 state transition。

這不是單純的資料結構偏大；它讓 run outcome、UI projection 與 async timer 的 ownership 綁在一起，並已形成 exception-path cleanup 漏洞。

#### 最小修正方向

至少拆成：

- `RunOutcomeAccumulator`
- `RunPresentation`

每次 run 建立新的 presentation/outcome instance；subscriber 只透過「目前 active run」reference 寫入。Run 結束時原子 detach，而不是逐欄設為 null。

---

### 4. Event handler 實際是一個獨立的 run presenter authority

- **Severity**：authority — 高
- **位置**：`src/agent.ts:707-1069,1742-2087`

#### 問題

以下規則都集中在 `agent.ts`：

- tool progress tracking
- subagent dashboard
- progress debounce/throttle
- stream delta rendering
- Slack Block Kit final-response ownership
- diagnostics
- SSE/agent-event mirror
- Sentry metrics
- retry與 compaction UI
- final response replacement
- silent-response handling

這些規則共同構成「把 harness events 投影到平台 response」的深 module，而不是 createRunner 的局部接線。

目前新增一種 harness event、presentation frontend 或 progress policy，都必須修改 runner composition root。讀者也必須吸收整套 rendering lifecycle，才能理解 `createRunner` 的 dependency wiring。

#### 最小修正方向

抽成有重量的 `RunPresenter` module，例如：

```ts
interface RunPresenter {
  beginRun(context: RunPresentationContext): void;
  handleEvent(event: HarnessEvent): Promise<void>;
  finish(outcome: RunOutcome): Promise<void>;
  dispose(): void;
}
```

它應擁有 progress state、responder queue、telemetry projection 與 final rendering；不要只把現有 helper 各搬成一個薄檔案。

---

### 5. Runtime workspace path vocabulary 在 projection 與 agent 各自定義

- **Severity**：authority — 高
- **位置**：`src/agent.ts:320-337,399-406,454-620`
- **重複 authority**：`src/workspace-projection/index.ts:30-52`

#### 問題

`workspace-projection` 自稱 single office-data policy seam，並決定 mount target，例如：

```text
/workspace/<office key>
```

但 `agent.ts` 又自行：

- 以 `runtimeWorkspaceRoot + office.key` 建立 conversation/scratch paths
- 以 host workspace 字串前綴翻譯 skill paths
- 把這些自行推導的路徑寫入 system prompt

因此 mount authorization、skill links 與 prompt 顯示路徑不是由同一 authority 產生。若 projection 的 mount target 或 layout 改變，三者可能漂移。

`loadMikanSkills` 的 `translatePath` 也沒有使用 sandbox 已提供的 `RuntimePathContext` translation seam。

#### 最小修正方向

讓 `WorkspaceProjection` 直接提供 runtime-relative targets，或新增由 projection + `RuntimePathContext` 產生的 `ProjectedWorkspacePaths`：

```ts
interface ProjectedWorkspacePaths {
  workspaceRoot: string;
  conversationRoot: string;
  scratchRoot: string;
  hostToRuntime(path: string): string;
}
```

Prompt builder 與 skill resolver 只消費此產物，不自行重建路徑文法。

---

### 6. `loadMikanSkills` 同時決定來源、precedence、安全策略與 runtime relocation

- **Severity**：authority — 中
- **位置**：`src/agent.ts:320-397,699-705`

#### 問題

`loadMikanSkills` 同時定義：

- package → workspace → conversation 的 precedence
- package skill mount translation
- workspace projection authorization
- conversation skill symlink policy
- diagnostics 與 skipped links
- name collision覆寫行為

Extension skills 又在 `mergeExtensionSkills` 使用另一段 precedence 規則。

這些規則共同回答「本次 agent 可見哪些 skills」，應有單一 resource authority，而不是 createRunner 的 private helper cluster。

新增 skill source 或修改 precedence 時，現在必須同時理解 package mounts、projection、extension loading 和 prompt formatter。

#### 最小修正方向

建立 skill catalog/resolver authority。輸入：

- office
- workspace projection
- runtime paths
- package skill sources
- extension skills

輸出：

- 已套用 precedence 的最終 skills
- 已 relocation 的 runtime paths
- diagnostics/skipped entries

不要只把 `loadMikanSkills` 原封不動搬到新檔案。

---

### 7. System prompt 內容 authority 與 materialization lifecycle 耦合在 runner factory

- **Severity**：authority — 高
- **位置**：`src/agent.ts:277-308,399-678,1573-1606,1688-1708,2118-2179`

#### 問題

主 prompt 大字串主要集中於 `buildSystemPrompt`，但完整 prompt lifecycle 分散在：

- boot placeholder prompt：`agent.ts:2118-2179`
- per-run重新 materialize：`agent.ts:1573-1606`
- base system prompt：`agent.ts:454-642`
- turn framing：`agent.ts:657-678`
- Session Dream maintenance prompt：`agent.ts:1688-1708`
- memory loading：`agent.ts:277-308`
- skills loading與 precedence：`agent.ts:320-397,699-705`

`createRunner` 必須知道：

- 何時使用 empty platform
- 何時重建 system prompt
- 哪些資訊可進 system prompt
- 哪些資訊必須放 user turn，才能維持 provider prompt cache

因此文字模板雖大致集中，prompt materialization rule 沒有單一 authority。Prompt cache stability 目前是跨函式的隱含不變量。

#### 最小修正方向

建立 `PromptPlan`/prompt builder authority，明確回傳：

```ts
interface PromptPlan {
  baseSystemPrompt: string;
  turnInstructions: string;
  maintenancePrompt?: string;
}
```

並集中聲明哪些 inputs 是 session-stable、哪些是 turn-scoped。Runner 僅負責套用結果。

---

### 8. `createConfiguredAgentSession` 與 `createRunner` 疊成雙層 composition root

- **Severity**：authority — 高
- **位置**：`src/agent.ts:1278-1501,2093-2221`

#### 問題

外層 `createRunner` 負責：

- executor
- base tools
- projection
- session storage
- initial prompt

內層 `createConfiguredAgentSession` 又負責：

- extension host services
- extension activation
- subagent service/tool
- profile filtering
- extension tools
- `MikanAgentSession`

兩層都掌握 model/tools/extensions/subagents/session。相同資源的 authority 沒有清楚歸屬。

要回答「最終 main agent 有哪些 tools」或「subagent 能看到哪些 extension tools」，必須跨兩個 composition flow，並追蹤 mutable closure `session` 與 `runnableSubagentProfiles`。

#### 最小修正方向

以資源 authority 產生明確產物：

1. `ExecutionBinding`
2. `AgentResourceCatalog`（tools、skills、profiles、extensions）
3. `ConfiguredAgentSession`
4. `RunPresenter`

`createRunner` 僅協調這些深 module，不再自行實作其內部規則。

---

### 9. `getCurrentStep()` 把可能並行的 pending tools 偽裝成單一 current step

- **Severity**：naming — 中
- **位置**：`src/agent.ts:718-726,1771-1842,2491-2500`

#### 問題

`pendingTools` 是 Map，明確允許同時存在多筆；`getCurrentStep()` 卻直接回傳 insertion order 的第一筆。

方法名稱暗示存在一個權威的 current step，但實作沒有 current selection policy。並行 tool/subagent 執行時，runtime 顯示哪一步取決於事件抵達順序，而不是：

- 最新開始
- 最久執行
- main-agent tool
- highest-priority tool

#### 最小修正方向

若 consumer 需要完整狀態，改為：

```ts
getActiveSteps(): ActiveStep[];
```

若 UI 只能顯示一筆，則命名為 `getOldestPendingStep()`，並在 interface 明確記錄 selection rule。

---

### 10. `PiAgentWrapper` 混合 agent lifecycle 與 extension transport routing

- **Severity**：authority — 中
- **位置**：`src/agent.ts:2453-2480`
- **Interface**：`src/types.ts:492-531`

#### 問題

`PiAgentWrapper` 同時暴露兩類能力：

#### Agent runner lifecycle

- `syncChatHistory`
- `run`
- `dreamSessionMemory`
- `abort`
- `getCurrentStep`
- `dispose`

#### Extension transport routing

- `tryExtensionCommand`
- `tryExtensionAction`
- `tryExtensionScheduleCallback`

其中 `tryExtensionAction` 與 `tryExtensionScheduleCallback` 幾乎只是 registry delegation；`tryExtensionCommand` 額外包含 command parsing 與 platform context adaptation。

Runtime 因而透過名為 `PiAgentWrapper` 的 interface 操作兩個 module：agent runner 與 extension router。未來替換 pi runner 時，extension platform routing 也被迫跟著 wrapper 重組。

#### 最小修正方向

把 extension routing 表達成獨立的 `ExtensionDispatch` capability。

如果 runtime cache 必須只保存一個聚合資源，則至少改用更誠實的聚合名稱，例如：

```ts
interface ConversationRunner {
  agent: AgentRunControl;
  extensions: ExtensionDispatch;
  dispose(): Promise<void>;
}
```

`PiAgentWrapper` 目前的名稱錯誤暗示所有 exposed methods 都屬於 pi agent lifecycle。

---

## `PiAgentWrapper` 方法深度判斷

| 方法                           | 判斷                      | 理由                                                                                      |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------- |
| `run`                          | 深                        | 隱藏 executor resolution、prompt materialization、budget、response lifecycle 與 telemetry |
| `dreamSessionMemory`           | 深                        | 隱藏 maintenance prompt、restricted tools、budget 與 hidden responder                     |
| `syncChatHistory`              | 有效 facade               | 雖短，但隱藏 conversation/session storage context，刪除後會把組裝細節推給 runtime         |
| `abort`                        | 合理 lifecycle delegation | Thin，但作為 runner cancellation interface 有存在必要                                     |
| `getCurrentStep`               | 藏規則但命名不準          | 選擇 Map 第一筆是一項未公開的 selection policy                                            |
| `tryExtensionCommand`          | 混合 adapter 規則         | 包含 parse、context shaping 與 registry dispatch                                          |
| `tryExtensionAction`           | thin delegation           | 幾乎直接轉呼叫 registry                                                                   |
| `tryExtensionScheduleCallback` | thin delegation           | 幾乎直接轉呼叫 registry                                                                   |
| `dispose`                      | 合理 resource authority   | 對外提供 runner aggregate 的單一 cleanup seam                                             |

---

## 建議的 Authority 拆分

拆分不應按行數，也不應把每個 helper 搬成一檔。建議按刪除測試拆成五個深 module：

### 1. Prompt authority

負責：

- memory/skills/platform/workspace inputs
- base system prompt
- turn instructions
- Session Dream prompt
- cache-stability分類

### 2. Agent resource catalog

負責：

- tools
- skills
- profiles
- extensions
- precedence
- visibility與 collision diagnostics

### 3. Execution binding

負責：

- per-actor executor resolution
- stable executor delegation
- runtime workspace paths
- host/runtime path translation

### 4. Run presenter

負責：

- responder queue
- tool/subagent progress
- streaming
- diagnostics
- telemetry projection
- final response rendering

### 5. Conversation runner composition root

只負責組裝：

- execution binding
- resource catalog
- prompt authority
- configured agent session
- run presenter
- session storage lifecycle

`run()`、Session Dream 與 session storage lifecycle 留在最終 conversation runner。單純把現有 private functions 各自搬到新檔案，不會改善 authority 或 module depth。
