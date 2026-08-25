# mikan Runtime / Sessions / Office 設計審查

審查範圍：

- `src/runtime/`
- `src/sessions/`
- `src/office/`

審查框架：AGENTS.md File-Split Scale（Slot／Authority／Weight）與 resource authority。

以下只列設計不合理點，不重報近期已修復的 v4 session single-writer serialization 問題。

## Finding 1：runtime state transition 與 `SessionLifecycle` 各自維護同一套 runtime identity grammar

**Severity：High**

### 檔案與行號

- `src/runtime/session-lifecycle.ts:17-27`
- `src/runtime/session-lifecycle.ts:44-67`
- `src/runtime/conversation-runtime.ts:103-106`
- `src/runtime/conversation-runtime.ts:821-836`

### 問題

`SessionLifecycle` 明確宣告自己是 runtime state identity 的 authority，內部使用：

```ts
`${officeKey(address)}|${sessionKey}`;
```

索引：

- cached states
- event queues
- closing runners

但 `ConversationRuntimeImpl.getOrCreateState()` 又建立自己的 `stateTransitions` map，手工重建完全相同的 composite id：

```ts
const id = `${officeKey(options.address)}|${options.sessionKey}`;
```

這不是單純資料結構重複。`stateTransitions` 保護的正是 runner state 建立、替換與 writer ownership transition，屬於 session lifecycle 的一部分。現在 runtime cache 的 identity grammar 有兩個 authority；任何 office/session identity 改動都必須同步修改兩處。

### 最小修正方向

把單飛 transition 放進 `SessionLifecycle`，例如：

```ts
sessions.transition(address, sessionKey, async () => ...)
```

或提供一個不暴露字串的 keyed single-flight primitive。`conversation-runtime.ts` 只傳 `(address, sessionKey)`，不得再自行組 composite key。

---

## Finding 2：rotation workflow 有兩個可獨立啟用的 authority

**Severity：High**

### 檔案與行號

- clock rule：`src/sessions/rotation.ts:1-46`
- runtime workflow：`src/runtime/conversation-runtime.ts:307-367`
- runtime dispatch：`src/runtime/conversation-runtime.ts:515-520`
- sync-level rotation option：`src/sessions/types.ts:71-79`
- sync-level decision：`src/sessions/chat-history-sync.ts:124-138`
- sync-level execution：`src/sessions/chat-history-sync.ts:214-240`

### 問題

`rotation.ts` 正確地只擁有「是否跨 biweekly bucket」的 clock rule；但「決定何時 rotate、rotate 前後要做什麼」同時存在兩條 workflow：

1. `ConversationRuntime.scheduleSharedSessionRotation()`：
   - shared/top-level policy
   - conversation maintenance barrier
   - Session Dream
   - reset
   - 重新執行原事件
2. `ChatHistorySync.resolveSessionScope({ rotateTopLevelSession: true })`：
   - 直接檢查 rotation rule
   - 建新 session
   - bootstrap history
   - 沒有 Session Dream 或 maintenance barrier

production runtime 目前刻意傳 `rotateTopLevelSession: false`，所以主流程行為正確；但 `ChatHistorySync` 的公開 interface 仍允許 caller 啟動第二種、語義較弱的 rotation。

因此 rotation 決策不是單一 authority，而且同一個 session 何時輪替、輪替前是否保存 memory，取決於 caller 選哪個入口。

### 最小修正方向

移除：

```ts
ResolveChatSessionScopeOptions.rotateTopLevelSession;
```

以及 `ChatHistorySync` 內的 rotation 判斷。保留：

- `rotation.ts`：純 clock policy
- runtime：完整 rotation workflow
- `ChatHistorySync`：建立／bootstrap／sync 指定 scope，不自行決定是否 rotation

若 tests 或 CLI 需要直接 rotate，新增語義明確的 `rotateTopLevelSession()` operation，而不是在 scope resolution 上放 boolean。

---

## Finding 3：新建 runner 的第一個事件會觸發兩次 chat-history sync pipeline

**Severity：Medium**

### 檔案與行號

- scope resolution：`src/runtime/conversation-runtime.ts:839-872`
- sync after state resolution：`src/runtime/conversation-runtime.ts:540-550`
- scope resolution 自行 sync existing session：`src/sessions/chat-history-sync.ts:214-234`
- scope resolution 自行 bootstrap new session：`src/sessions/chat-history-sync.ts:238-253`
- runner sync adapter：`src/agent.ts:2223-2230`
- actual incremental sync：`src/sessions/chat-history-sync.ts:150-160`

### 問題

對 cache miss：

1. `getOrCreateStateExclusive()` 呼叫 `resolveSessionScope()`。
2. `resolveSessionScope()`：
   - existing session：已跑 `syncSessionFromLog()`
   - new session：已跑 `bootstrapSessionFromLog()`
3. 回到 `runSession()` 後，又無條件呼叫：

   ```ts
   await state.runner.syncChatHistory(event.ts);
   ```

第二次通常會被 watermark／represented-message dedupe 化成 no-op，但仍會：

- 再讀一次完整 `log.jsonl`
- 再讀 session entries
- 進入第二套 sync invocation path

對 cache hit，runtime 的 explicit sync 是必要的；對 cache miss，scope resolution 已做過。這表示「每個事件何時觸發 sync」分散在 runtime 和 scope resolver，而不是只有一個 authority。

### 最小修正方向

讓 state resolution 回傳是否已同步，例如：

```ts
{ state, historySynced: boolean }
```

cache miss/bootstrap 後跳過第二次 sync。

較深但更乾淨的方向是：

- `resolveSessionScope()` 只 resolve/materialize scope，不增量同步 existing session
- runtime 在 writer runner 建立完成後統一執行一次 sync
- new-session bootstrap 作為 materialization 的必要部分，明確與 incremental sync 分開命名

不要只依賴 dedupe 來吸收重複觸發。

---

## Finding 4：`ConversationRuntimeImpl` 仍直接擁有約 100 行 Sentry implementation knowledge

**Severity：Medium**

### 檔案與行號

- imports：`src/runtime/conversation-runtime.ts:19-25`
- invocation：`src/runtime/conversation-runtime.ts:595-609`
- implementation：`src/runtime/conversation-runtime.ts:642-740`

### 問題

conversation runtime 的合理 authority 是：

- command/run dispatch
- queue 與 maintenance ordering
- runner lifecycle/cache
- stop/reset/rotation workflows
- shutdown settlement

但 `runWithInstrumentation()` 直接知道：

- Sentry span construction
- scope mutation
- attribution attribute spelling
- metrics names 和 units
- breadcrumb fields
- error-reporting domain/surface/operation taxonomy

這些是 observability adapter knowledge，而非 conversation resource lifecycle。它使 runtime interface 沒變深，反而讓 runtime reader 必須吸收一整套 Sentry implementation 才能理解 run path。

這是 `conversation-runtime.ts` 逼近 900 行中最明確的「無關 authority 擠在一起」。其餘 queue、command dispatch、cache、rotation、shutdown 都至少共享 conversation-run ordering，不應只因行數拆開。

### 最小修正方向

把完整 wrapper 移至 `src/observability/`，例如：

```ts
instrumentConversationRun(context, meta, body);
```

runtime 只提供 run metadata 與 callback。不是建立新的抽象層；現有 Sentry-specific implementation 本來就已有 observability module，這是把 adapter 放回既有 Slot。

---

## Finding 5：conversation-id validation 有兩個同名 authority，接受範圍不同

**Severity：Medium**

### 檔案與行號

- office validator：`src/office/address.ts:41-59`
- session-key validator：`src/sessions/session-key.ts:29-50`

### 問題

兩個 module 都 export：

```ts
assertConversationId();
```

但規則不同：

- office version 拒絕 empty/path markers/path separators/control characters
- session-key version除了類似檢查，還拒絕 `:`
- control-character 範圍也不完全相同：
  - office 拒絕 `0x7f–0x9f`
  - session-key 只明確拒絕 `0x7f`

`OfficeAddress` 是 canonical conversation identity；session key 則建立在 conversation id 上。現在可以先建立一個合法 `OfficeAddress`，之後在 session-key derivation 才發現同一 raw id 不合法。

這代表 conversation identity 的 accepted domain 沒有單一 authority，也使 import 時容易拿錯同名 symbol。

### 最小修正方向

把 raw conversation-id 的共同安全規則集中到 office identity authority。若 `:` 禁令確實是所有可執行 conversation 的全域 invariant，就由 `src/office/address.ts` 統一拒絕，session-key 直接 reuse。

若某些未來 office 允許 `:`、只有 session grammar 不允許，則至少：

- 將 session 版本改名為 `assertSessionConversationId`
- reuse office validator 後只補 `:` 規則
- 明確記錄這是 session-grammar narrowing，不要維持兩份完整 validator

---

## Finding 6：一次性 v3 migration 被放進永久 npm public surface

**Severity：Medium**

### 檔案與行號

- migration implementation：`src/sessions/migrate-v3.ts:1-467`
- public export：`src/index.ts:14`
- CLI consumer：`src/cli/sessions.ts:14-62`
- public-surface lock-in：`src/test/public-api.test.ts:40-53`
- runtime rejection message：`src/harness/session-store.ts:190`

### 問題

`migrate-v3.ts` 放在 `src/sessions/` 本身合理：

- 它填 session format migration 的 Slot
- 需要同時理解 v3 tree、v4 mutations、compaction context verification，具有足夠 Weight
- 不是應拆散到 runtime 或 harness 的一般 session path logic

不合理的是 `findV3SessionFiles`、`isV3SessionFile`、`migrateSessionFile` 被提升成 package public interface。這把明確標為「one-time migration」的 transitional code 變成 semver 承諾，使未來刪除成本高於 CLI-only migration。

### 最小修正方向

下一個允許收窄 public surface 的 major release：

1. 從 `src/index.ts` 移除 migration exports。
2. CLI 繼續直接 import internal module。
3. 保留 runtime v3 detection 與 actionable error，直到支援窗口結束。
4. 到期後整體刪除：
   - `src/sessions/migrate-v3.ts`
   - `src/cli/sessions.ts` 的 migrate command
   - v3-specific tests/docs
   - `SessionStore` 的 v3 actionable error，改成 generic unsupported-version error

#### 何時可刪

不能以「main 已改用 v4」作為刪除條件。合理條件是：

- 已跨過文件承諾的 upgrade/support horizon；例如最後可直接升級來源版本已 EOL
- release notes 已提前公告 migrate command removal
- production/support telemetry 或實際部署清單顯示不再需要 v3 bridge
- `.v3.bak` 不再被任何 recovery/documented rollback path 使用

**疑問：**目前未看到 repo 內明確寫出的 migration support horizon。若套件外部 embedder 正在直接呼叫 public migration functions，移除需 major release。

---

## Finding 7：Admin UI 手工建立另一個依賴 `:` 保留規則的 identity grammar

**Severity：Medium**

### 檔案與行號

- `src/web/admin/portal.ts:1982-1991`
- session grammar authority：`src/sessions/session-key.ts:7-14`
- office identity/key authority：`src/office/address.ts:61-74`

### 問題

grep 沒發現其他 production TypeScript 直接 split session key；`session-key.ts` 的實際 session-key grammar 大致有守住。

唯一值得列的是 Admin browser script：

```js
const defaultConversationKey = platform + ":" + conversationId;
const sep = key.indexOf(":");
```

註解明確依賴 session-key authority 的「conversation ids never contain `:`」規則，但這個字串不是 session key，而是另一套 UI scope key grammar。

因此 session grammar 的保留字規則洩漏到無關 UI identity。若 conversation-id 規則改變，或 UI key 後來承載其他 identity，這段不會經 TypeScript authority 驗證。

### 最小修正方向

不要序列化成可解析字串。UI state 保存：

```js
{
  (platform, conversationId);
}
```

若 DOM/select 必須要 scalar key，使用 `officeKey` 或 JSON encoding，而不是再發明 `platform:id` grammar。

**疑問：**若此 key 只存在單一頁面的 ephemeral JavaScript、完全不跨 DOM value／storage／network，severity 可降為 Low；目前程式至少已把它當可切換的 `activeConversationKey`。

---

## Finding 8：session layer 已有 `Office`，但主要 interface 仍降級成未標型別的 `conversationDir: string`

**Severity：Low**

### 檔案與行號

- canonical path fields：`src/office/types.ts:45-62`
- session directory authority：`src/office/layout.ts:26-33`
- sync option bags：`src/sessions/types.ts:71-103`
- sync derivation：`src/sessions/chat-history-sync.ts:124-145`
- log path reconstruction：`src/sessions/conversation-log.ts:10-16`
- runtime downgrade：`src/runtime/conversation-runtime.ts:527-532`
- state creation：`src/runtime/conversation-runtime.ts:847-865`

### 問題

session-file directory 規則本身目前沒有兩處都寫 `join(dir, "sessions")`：

- `office/layout.ts` 擁有 `<office>/sessions`
- `sessions/store.ts` 擁有 pointer、main filename、thread filename 與 lineage

這個 authority 邊界是清楚的。

殘留問題是 runtime 已持有完整 `Office`，但仍把它降級成 `conversationDir: string` 傳入 sessions 層；sessions 再從該 string 推導：

- sessions directory
- `log.jsonl`
- thread files

因此 `Office.sessionsDir`、`Office.logPath` 的型別級 resource authority 沒有真正穿過 seam。任何普通 directory 都可被當成 conversation office，錯誤要到 filesystem I/O 才暴露。

### 最小修正方向

逐步讓高層 session operations 接受：

```ts
{ office: Office, ... }
```

並使用：

```ts
office.sessionsDir;
office.logPath;
office.dir;
```

`store.ts` 中真正需要處理任意 session directory 的低階 helpers 可以繼續接受 string；不必一次重寫所有測試與 migration code。

這是低風險的 authority deepening，不代表目前路徑公式已重複。

---

## 補充：未列為 finding 的設計判斷

- `session-lifecycle.ts` 有明確 **Authority + Weight**：state cache、per-key queue、conversation maintenance barrier、eviction、closing settlement 必須共同維持 lifecycle invariants。
- `sessions/store.ts` 與 `office/` 的主要 path authority 邊界目前合理：
  - office 擁有 office/session directory layout
  - store 擁有 session filenames、`current` pointer、thread path 與 lineage
- `rotation.ts` 作為純 biweekly clock rule 有充分 **Authority**；問題在 workflow 被兩個 caller 實作，不在檔案本身。
- `session-key.ts` 是明確的 grammar authority；production grep 未發現其他地方直接 hand-parse 真正的 session key。
- `office/migration.ts` 與 `office/registry.ts` 雖大，但各自有清楚 Weight：
  - migration 擁有 legacy layout transition workflow
  - registry 擁有 durable mapping/journal 與 crash-safe transition rules
- `migrate-v3.ts` 的位置與單檔重量合理；需管理的是支援期限與 public-surface permanence，不是現在拆檔。
