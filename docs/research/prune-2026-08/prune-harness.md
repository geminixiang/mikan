# `src/harness` / `src/agent` / `src/runtime` 唯讀剪枝審計

日期：2026-08-27

## 範圍與限制

- 完整通讀：
  - `src/harness/`（含 frozen `extensions/`）
  - `src/agent/`
  - `src/runtime/`
- 前置文件：`AGENTS.md`、`docs/research/pi-dev-watch-2026-08.md`
- 對照依賴：
  - `@earendil-works/pi-agent-core@0.84.3`
  - `@earendil-works/pi-ai@0.84.3`
- 未修改任何 repository 檔案。
- 遵守 dev-watch 決策：沒有提出重構 `src/harness/runner.ts` run loop；只列明確死碼或薄重複。
- `src/harness/extensions/` 視為 frozen、keep-not-expand；完整檢查後沒有找到可確認的死碼，因此不提出重構。

## 摘要

| 類別                             | 項數 |                                           預估省行數 |
| -------------------------------- | ---: | ---------------------------------------------------: |
| `safe` 可直接考慮                |    6 |        約 28–39 行 production；含專屬測試約 46–67 行 |
| `confirm` 需確認介面／可觀察行為 |    7 | 約 143–220 行 production；含專屬測試可再多約 5–14 行 |
| 合計（候選不互相重複後）         |   13 |                             約 171–259 行 production |

最大候選是技能載入器與 pi-agent-core 的重疊，但它牽涉 conversation office 的 symlink trust boundary，不能直接整段替換。明確、低風險的剪枝主要是兩個 `contentText` 複本、runtime 死參數／死 options、重複 Promise wait，以及孤立註解。

## Findings

### 1. `getFinalAssistantText()` 重複 `pi-ai.contentText`

- **檔案:行號**：`src/agent/presenter.ts:116-126`
- **依賴證據**：
  - `@earendil-works/pi-ai/dist/index.d.ts:31` 公開 `contentText`
  - `@earendil-works/pi-ai/dist/utils/text.d.ts:4`
  - `@earendil-works/pi-ai/dist/utils/text.js:2-8`
- **問題**：本地 helper 尋找最後一則 assistant message 後，手動 filter `type === "text"`、map `text`、以 `"\n"` join。`contentText(content)` 的規則相同。
- **建議動作**：保留「尋找最後一則 assistant」的 domain 邏輯，文字抽取改用 `contentText(lastAssistant?.content ?? [])`；刪除本地 filter/map/join。
- **預估省行數**：5–7 行
- **風險**：`safe`

### 2. `assistantText()` 重複 `pi-ai.contentText`

- **檔案:行號**：`src/harness/subagent-runner.ts:429-435`
- **依賴證據**：同 Finding 1；`contentText` 接受自訂 separator。
- **問題**：本地 helper 過濾 text parts 並以空字串 join，等價於 `contentText(message.content, "")`。
- **建議動作**：呼叫處改為 `assistant ? contentText(assistant.content, "") : ""`，刪除 helper。
- **預估省行數**：4–6 行
- **風險**：`safe`

### 3. `SessionStateOptions` 含兩個從未讀取的欄位

- **檔案:行號**：
  - `src/runtime/types.ts:59-70`
  - 傳入點：`src/runtime/conversation-runtime.ts:198-203,328-334,461-468,547-553`
  - 消費端：`src/runtime/conversation-runtime.ts:789-823,834-837`
- **問題**：`conversationId` 與 `conversationKind` 被各呼叫點傳入，但 `getOrCreateStateExclusive()` 只取 `address`、`sessionKey`、`currentMessageId`；`createCurrentRunner()` 只使用 `address`、`sessionKey`。`conversationId` 已可由 `address.conversationId` 得到。schedule callback 還為填死欄位額外呼叫 `inferConversationKind(...)`。
- **建議動作**：只從內部 `SessionStateOptions` 與各傳入點刪除兩欄；若 import 因此無用途一併刪除。不要順手移除 `handleExtensionAction()` 的公開 `conversationKind` 參數，後者跨 adapter contract。
- **預估省行數**：12–18 行
- **風險**：`safe`（限內部 options）；擴及公開 handler contract 則為 `confirm`

### 4. `createCurrentRunner()` 的 `conversationDir` 參數未使用

- **檔案:行號**：
  - 宣告：`src/runtime/conversation-runtime.ts:789-793`
  - 呼叫：`src/runtime/conversation-runtime.ts:862-866`
- **問題**：參數未在方法本體讀取；runner 已由 `options.address` 與 `sessionScope` 取得所需資料。
- **建議動作**：刪除參數及呼叫點 argument。
- **預估省行數**：1–2 行
- **風險**：`safe`

### 5. `closeAll()` 對同一批 dispose promises 重複等待

- **檔案:行號**：`src/runtime/session-lifecycle.ts:245-254`
- **問題**：每個新 `close` 已由 `trackClosing()` 放入 `this.closing`，同時又保留在 `closes`；最後 `Promise.all([...this.closing.values(), ...closes])` 將同一 Promise 放入兩次。副作用不會執行兩次，但會重複建立 reaction，並誤導讀者兩集合互斥。
- **建議動作**：完成所有 `trackClosing()` 後只等待 `Promise.all(this.closing.values())`，並讓 `map` 改成不必回傳 close 的 iteration。
- **預估省行數**：1–3 行
- **風險**：`safe`

### 6. `presenter.ts` 尾端有失去對象的舊 JSDoc

- **檔案:行號**：`src/agent/presenter.ts:813-819`
- **問題**：`attachSessionEventHandlers()` 結束後留下描述「Create a new PiAgentWrapper」的孤立註解；對應 factory 已在 `runner.ts`，註解未附著任何 symbol。
- **建議動作**：直接刪除；不需搬移或重寫。
- **預估省行數**：7 行
- **風險**：`safe`

### 7. `translateRuntimePathToHost()` 是 production-dead 的一行薄 wrapper

- **檔案:行號**：
  - `src/agent/execution.ts:19-24`
  - re-export：`src/agent/index.ts:5`
  - 僅有 callers：`src/test/agent-prompt.test.ts:111,127,198`（import 約在第 7 行）
- **問題**：production 沒有 caller；函式只做 `pathContext.runtimeToHostPath?.(runtimePath) ?? runtimePath`。真正 attachment 流程使用安全規則較完整的 `translateAttachPathToHost`、`normalizeAttachRuntimePath`、`withStagedRuntimeFile`。`src/agent/index.ts` 也不是 package export map 的公開 entrypoint。
- **建議動作**：刪除函式、內部 re-export 及只驗證這一行 delegation 的測試；保留 attachment root/traversal 測試。
- **預估省行數**：production 約 7 行；含專屬測試約 25–35 行
- **風險**：`safe`

### 8. presenter 維護第二套 usage／LLM call 統計權威

- **檔案:行號**：
  - 本地初始化：`src/agent/presenter.ts:23-31,47-48,82-83`
  - summary/context：`src/agent/presenter.ts:355-417`
  - 手動累加：`src/agent/presenter.ts:655-664`
  - 子集合型別：`src/agent/types.ts:31-37`
  - 既有權威：`src/harness/runner.ts:188-228,457-466`、`src/harness/usage.ts:10-42`
- **問題**：harness 已以每次 prompt 的 tally 作為 usage authority，並透過 external usage sink 納入 subagent spend。presenter 又自行初始化與逐欄累加，已漏掉 `totalTokens`、`cacheWrite1h`、`reasoning`，且平台 summary／`agent.run.*` metrics 可能漏掉 subagent 用量。`llmCallCount` 也在兩層維護。
- **建議動作**：
  1. 最小安全步驟：presenter 改用 `harness/usage.ts` 的 `createEmptyUsage()`／`addUsage()`，移除重複初始化與累加程式；保持現有統計語義。
  2. 更深剪枝：run 完成後改用 `session.getLastRunStats().usage` 與 `.llmCalls`，刪除 `RunnerSessionState.totalUsage`／`llmCallCount` 的第二套 authority。
  3. context token 計算改用 pi-agent-core 公開的 `calculateContextTokens()`，避免手加四欄。
- **預估省行數**：
  - 步驟 1：約 15–22 行
  - 完成步驟 2–3：約 25–40 行（不要與步驟 1 疊加計算）
- **風險**：`confirm`。改用 harness stats 後 summary 會正確納入 subagent usage，屬可觀察數值變更；先確認產品期望與 metrics tests。

### 9. SSE `sessionStart` 被用於三種不同事件，retry 路徑會重複發射

- **檔案:行號**：
  - turn 開始：`src/agent/runner.ts:480-484`
  - assistant call 開始：`src/agent/presenter.ts:606-610`
  - retry 開始：`src/agent/presenter.ts:781-787`
- **問題**：相同 discriminator 同時代表 top-level turn、每次 LLM call、retry。retry 之後通常還會出現新的 assistant `message_start`，因此至少再收到一次 `sessionStart`。retry 已另發 `diagnostic`，額外的 `sessionStart` 沒有新語義。
- **建議動作**：先檢查 session-view/SSE consumers。若 `sessionStart` 定義為一次 turn，只保留 runner 的發射；最保守先刪 retry handler 中的重複發射。若 consumer 需要 call/retry 邊界，應新增語義明確的 event kind，而非重用 `sessionStart`。
- **預估省行數**：保守 5 行；統一語義後約 10–15 行
- **風險**：`confirm`（consumer 可能把重複事件當刷新訊號）

### 10. `foldExternalUsage()` 只有測試使用，完全委派既有 sink

- **檔案:行號**：`src/harness/runner.ts:229-231`
- **問題**：方法只做 `await this.captureExternalUsageSink()(usage)`，沒有增加驗證、錯誤語義或 domain rule。production callers 在 `src/agent/catalog.ts:288,325` 已直接使用 `captureExternalUsageSink()`；唯一外部 caller 是 `src/test/harness-runner.test.ts:755`。
- **建議動作**：確認沒有外部 `@geminixiang/mikan/harness` consumer 後刪除方法，測試直接呼叫 sink。除此之外不要整理 `runner.ts`。
- **預估省行數**：3 行
- **風險**：`confirm`（`MikanAgentSession` 經 `src/harness/index.ts` 公開，可能有 repository 外部 caller）

### 11. `officesForConversationId()` 只有測試使用的過渡 bridge

- **檔案:行號**：
  - `src/runtime/session-lifecycle.ts:152-160`
  - 唯一 caller：`src/test/session-lifecycle.test.ts:149-153`
- **問題**：production 無 caller；專屬測試只維持方法自身。註解稱它是 raw conversation id 到 `OfficeAddress` 的暫時 bridge，但目前 settings/admin/runtime 都未使用。
- **建議動作**：確認近期沒有尚未合併的 ADR 0005 migration caller 後，刪除 method 與專屬測試；若確實有排程用途，應以 issue/caller 說明取代無期限的「until」。
- **預估省行數**：production 9 行；含測試約 14–18 行
- **風險**：`confirm`（註解明示過渡用途）

### 12. `MikanModels.getAvailable()` 重做 pi-ai 的 model availability 篩選

- **檔案:行號**：`src/harness/models.ts:288-308`
- **依賴證據**：
  - `Models.getAvailable(providerId?, options?)`：`@earendil-works/pi-ai/dist/models.d.ts:119-123`
  - 實作：`@earendil-works/pi-ai/dist/models.js:255-273`
- **問題**：兩者都按 provider auth 篩選模型。本地版本自行 group providers，再以每組第一個 model 呼叫 `getAuth()`。依賴版本還會套用 provider-specific model filtering，但語義不完全相同：dependency 的 auth check 不刷新 OAuth，且錯誤聚合方式不同；本地版本會解析／可能刷新 OAuth，並逐 provider 吞掉失敗。
- **建議動作**：先確認此方法是否被依賴為 OAuth refresh side effect。若 UI 只需列出目前可用模型，可委派 `this.models.getAvailable()`；若要保留單 provider failure isolation，可逐 provider 呼叫 dependency method 並個別 catch。
- **預估省行數**：12–18 行
- **風險**：`confirm`

### 13. 技能 loader／formatter 與 pi-agent-core 高度重疊，但需保留 trust policy

- **檔案:行號**：
  - loader：`src/harness/skills.ts:50-245`
  - formatter：`src/harness/skills.ts:248-287`
- **依賴證據**：
  - `loadSkills`、`loadSourcedSkills`：`@earendil-works/pi-agent-core/dist/harness/skills.d.ts:23-43`，由 package index 公開
  - `formatSkillsForSystemPrompt`：`@earendil-works/pi-agent-core/dist/harness/system-prompt.d.ts:2`，由 package index 公開
- **問題**：
  - loader 重複 metadata validation、讀檔、遞迴 discovery、file/directory resolution、diagnostics。pi loader 使用完整 YAML parser，並支援 `.gitignore`／`.ignore`／`.fdignore`。
  - formatter 重複 XML escaping、`disableModelInvocation` 過濾與 `<available_skills>` 結構。
  - 不能直接整段替換：mikan 對 conversation skills 使用 `rejectSymlinks: true`，這是 office prompt trust boundary；pi loader 會解析 canonical target。mikan 還有 `baseDir`、`source`、`inline`，其中 inline extension skill 不能只輸出 host file location。
- **建議動作**：
  1. 對可信來源（例如 package/workspace 中政策允許的來源）使用 `loadSourcedSkills`，映射回 `MikanSkill` 的 `baseDir/source`。
  2. 對 conversation skills 保留小型 symlink 拒絕前置掃描／ExecutionEnv policy，再委派 pi loader；先用現有 trust-boundary tests 鎖定「任何將被讀取的 symlink 必須拒絕」。
  3. formatter 可先把 inline/non-inline 分組：非-inline 使用 `formatSkillsForSystemPrompt`，inline 保留 mikan formatter。若分組反而增加 seam 或改 prompt snapshot，則不做。
  4. `parseFrontmatter()` 仍被 subagent profiles 與 admin portal 使用，不能隨 loader 一起直接刪除。
- **預估省行數**：loader 約 100–150 行；formatter約 12–22 行；合計約 112–172 行
- **風險**：`confirm`（安全 seam、diagnostic shape、ignore 規則及 prompt snapshots 都可能改變）

## 只縮介面、不省行數的候選

### `DEFAULT_SUBAGENT_BUDGET`／`SUBAGENT_ABORT_GRACE_MS` 不必 export

- **檔案:行號**：`src/harness/subagent-runner.ts:26-33`
- **問題**：production 只在同檔使用；跨檔 callers 全是 `src/test/subagent-runner.test.ts`。未由 package barrel 公開。
- **建議動作**：若不再把實作常數當 white-box test seam，移除 `export`，測試改驗證 observable behavior。
- **預估省行數**：0 行；縮小內部介面
- **風險**：`confirm`

## Knip 與 unused-export 驗證

執行結果：

```text
> @geminixiang/mikan@1.0.0-beta.45 knip
> knip && knip --production --dependencies
```

- exit code 0
- unused files：無
- unused exports：無
- unused exported types：無
- unused dependencies：無
- `npx knip --include exports,files --reporter compact`：空輸出、exit code 0

Knip 沒有報告並不否定 Findings 7、10、11：它們被測試引用，或位於 package public surface，因此需要 import tracing 與介面判斷。相反地，這也表示沒有更多可僅靠靜態工具安全刪除的 export。

## 未發現／刻意不動

- `src/harness/extensions/loader.ts`、`registry.ts`、`types.ts`：沒有可確認死碼；動態 `jiti.import()`、activation、hook/tool/command/schedule/action registration 使低靜態引用不能視為 dead。
- `src/harness/runner.ts`：除 Finding 10 的三行薄 wrapper 外，不提出 run-loop 重構；等待 pi durable harness 正式 release/public M8 surface。
- `src/harness/usage.ts`：pi-agent-core/pi-ai 沒有公開等價的 usage aggregation helper；core 內部相似實作不是合法 public reuse seam。
- `src/harness/auth.ts`：pi-ai 沒有等價的原子、0600、持久化 file credential store。
- `src/harness/event-format.ts`：沒有依賴 export 可替代 mikan event schema、legacy alias 與 timestamp 規則。
- runtime 的 run settlement 與 harness 的 `runActive`：責任不同；前者管理 responder/runner cache/shutdown，後者保護單一 harness prompt，不視為重複。
- 未找到 `TODO`、`FIXME`、`HACK`、commented-out implementation、debug remnants 或明確實驗殘留。

## 建議執行順序

1. **Safe batch**：Findings 1–7；用既有相關單元測試與 `npm run knip` 驗證。
2. **Usage authority**：Finding 8；先新增/確認父 agent + subagent usage summary 測試，再移除第二套 tally。
3. **Consumer contract 確認**：Findings 9–11；先查 SSE consumers、外部 harness users、ADR 0005 migration plans。
4. **Dependency delegation**：Finding 12；確認 OAuth refresh/error semantics。
5. **技能 loader prototype**：Finding 13；先以 conversation symlink、ignore files、inline skills、diagnostic snapshots 做行為 oracle，確認實際淨省行數後再決定是否採用。

## 唯讀確認

- repository 工作樹在審計期間保持乾淨。
- 沒有執行任何 edit/write 到 repository；本報告只寫入 `/tmp/prune-harness.md`。
