# `src/web/` 唯讀剪枝審計

## 範圍與方法

- 已先閱讀 `AGENTS.md` 的 **Coding Rules** 與 **File-Split Scale**。
- 已逐檔閱讀 `src/web/` 下 20 個檔案，共 9,155 行；未修改 repository 內任何檔案。
- 用 `rg` 搜尋整個 repository（排除 `dist/`、`node_modules/`）驗證 export、handler、route literal、前端 fetch、測試與啟動接線。
- 判定原則：只有能指出實際刪減、重複權威、未接線功能或介面風險者才列入；HTTP route 與內嵌瀏覽器 JS 的動態呼叫均視為有效呼叫點。

## 發現

### 1. 未接線的 `/admin/api/me` endpoint

- **位置**：`src/web/admin/portal.ts:111-114`、`src/web/admin/portal.ts:309-318`
- **問題**：route 與 `serveMe` handler 已實作，但 admin portal 前端沒有呼叫，repository 其他程式與測試也沒有呼叫。
- **證據**：`rg -n --fixed-strings '/admin/api/me' . --glob '!dist/**' --glob '!node_modules/**'` 只命中 route 本身；`serveMe` 也只有該 route 一個呼叫點。
- **建議動作**：`delete`
- **預估省行數**：14-16 行
- **風險**：`safe`

### 2. 未接線且繞過 EventStore authority 的 raw event-file endpoint

- **位置**：`src/web/admin/portal.ts:171-174`、`src/web/admin/portal.ts:1841`、`src/web/admin/portal.ts:1881-1918`
- **問題**：`/admin/api/events/file` 與 `serveEventsFile` 沒有 UI 或其他 caller。它直接從 `workspace.eventsDir` 讀 raw file，與同檔其餘 event list/read/delete 已刻意改走 injected `EventStore` 的 authority 相衝突；屬於舊實作殘留。
- **證據**：`rg -n --fixed-strings '/admin/api/events/file' . --glob '!dist/**' --glob '!node_modules/**'` 只命中 route；前端的 event UI 只呼叫 `/admin/api/events`、`/admin/api/conversations/events` 與 delete endpoint。handler 也只有該 route 呼叫。
- **建議動作**：`delete`
- **預估省行數**：43-48 行（含 route、常數與 handler；若 import 因此可縮減則再少 1-2 行）
- **風險**：`safe`

### 3. JSON body parser 未驗證 object-root，且 session view 重複手寫一份較脆弱版本

- **位置**：`src/web/portal-shell.ts:30-49`；`src/web/session-view/portal.ts:583-602`；受影響 caller：`src/web/login/portal.ts:297-323`、`src/web/admin/portal.ts:185-200`
- **問題**：共用 `readJsonBody` 將任何合法 JSON 直接 cast 成 `Record<string, unknown>`；`null`、array、string、number 都會通過。login 隨後以 `Partial<...>` 再 cast，`null` 可在 handler 讀 property 時觸發 500。session message 又自行 `readRawBody + JSON.parse + cast`，重複同一問題與錯誤回應樣板。這不只是型別問題：tool/API 介面應明確要求 object-root。
- **建議動作**：`merge`（讓 `readJsonBody` 驗證 non-null、非 array object；session message 改用它，刪除本地 parse block）
- **預估省行數**：12-18 行
- **風險**：`safe`

### 4. Admin client 的 `escAttr` 被錯用於 inline JavaScript 字串，形成脆弱的 escaping 邊界

- **位置**：helper `src/web/admin/portal.ts:2203-2212`；危險用法包括 `src/web/admin/portal.ts:2506-2508`、`2565-2568`、`2720-2723`、`2949-2952`、`3005-3008`、`3331-3334`
- **問題**：`escAttr` 只做 HTML entity escaping，但值被插入 `onclick="fn('...')"` 的 JavaScript string context。瀏覽器解析 attribute 時會把 `&#39;` 還原成 `'`，因此這不是 JavaScript escaping；conversation id、event name、package/skill metadata 等若含引號或反斜線，可能破壞 handler，最壞可形成 script injection。`escHtml` 與 `escAttr` 的兩份近似 helper 也讓 context 看似安全、實際不安全。
- **建議動作**：`merge`（移除 inline `onclick` 字串拼接與 `escAttr`，以 `data-*` + 單一 delegated event listener 處理；DOM 顯示內容繼續使用 `escHtml`）
- **預估省行數**：8-20 行（取決於事件 delegation 合併程度）
- **風險**：`confirm`

### 5. Session page、SSE stream、message POST 重複解析同一 token/session target

- **位置**：page path `src/web/session-view/portal.ts:106-159`；stream path `src/web/session-view/portal.ts:498-549`；message path `src/web/session-view/portal.ts:604-649`
- **問題**：三條 endpoint 各自重複：檢查 store、`peek(token)`、讀 requested session、呼叫 `resolveRequestedSessionFile`、處理 corruption/not-found，之後再算 displayed session key。三份流程已出現不同狀態碼與錯誤文字，後續若收緊 session authorization，容易只改到其中一條。
- **建議動作**：`merge`（建立同檔 private resolver，回傳 entry、target file、active session key；各 endpoint 只保留 transport-specific response mapping）
- **預估省行數**：25-40 行
- **風險**：`confirm`

### 6. JSON response helper 重複兩份

- **位置**：`src/web/admin/portal.ts:1946-1952` 的 `jsonRes`；`src/web/session-view/portal.ts:781-787` 的 `json`
- **問題**：兩個 helper 實作完全相同：status、JSON content type、`no-store`、`JSON.stringify`。這是同一 HTTP response policy 的兩個 authority；login 另有多處手寫 JSON error response。
- **建議動作**：`merge`（移至 `src/web/portal-shell.ts`，admin/session 共用；login 的相同回應也逐步收斂）
- **預估省行數**：8-14 行
- **風險**：`safe`

### 7. Login 與 Session 各自再包一層 HTML document/status-page renderer

- **位置**：`src/web/login/portal.ts:713-741`；`src/web/session-view/portal.ts:789-811`
- **問題**：兩邊都在 `renderPortalShell` 上重複建立 `renderHtmlDocument` 與 error/status card。差異只在 active view、styles/script/body attributes 與 login 的 success tone。`renderPortalShell` 已是 portal chrome authority，但 status-page 結構仍分叉；目前已有產品名一邊用 `${PRODUCT_NAME}`、另一邊硬編碼 `mikan` 的漂移。
- **建議動作**：`merge`（在既有 `portal-shell.ts` 增加可選 portal shell options 的 status-page renderer，而不是再建新模組；刪除兩份本地 document/status wrapper）
- **預估省行數**：14-22 行
- **風險**：`confirm`

### 8. Admin 前端重複 scope/fetch/render-error 樣板，造成大量平行 loader

- **位置**：基礎 helper `src/web/admin/portal.ts:2188-2240`；重複 loader 主要分布於 `src/web/admin/portal.ts:2333-3340`
- **問題**：`loadSettings`、`loadWorkspace`、`loadSkills`、`loadPackages`、`loadMcpServers`、`loadConversationEvents`、`loadEvents`、`loadAllConversations`、`loadSessionUsage`、`loadGlobalSettings`、`loadGlobalSkills` 等反覆執行同一流程：找 container、塞 Loading、`apiGet`、空結果分支、catch 後塞 escaped error。不是所有 renderer 都能抽象化，但 loading/error transport policy 已重複十餘次，使 UI error handling 易漂移。
- **建議動作**：`merge`（只合併 fetch/loading/error orchestration 成一個接受 container 與 success renderer 的 helper；保留各 domain renderer，避免過度抽象）
- **預估省行數**：35-60 行
- **風險**：`confirm`

### 9. Session message endpoint 未限制實際訊息文字大小，只限制整個 JSON body 1 MiB

- **位置**：`src/web/session-view/portal.ts:583-611`
- **問題**：`text` 只做 `trim()` 與 non-empty 檢查。1 MiB JSON 仍允許接近 1 MiB 的單則訊息進入 adapter/runtime，遠高於各平台與模型的合理輸入界線；錯誤會延後到更深層，介面邊界不明確。前端 textarea 的視覺高度限制不是資料限制。
- **建議動作**：`merge`（把 message body 的 object-root、必填欄位與 text 長度驗證併入第 3 項的共用解析/validation 流程；不要另建 wrapper）
- **預估省行數**：0-4 行（主要收益是強化介面，若與既有分支合併可略減碼）
- **風險**：`confirm`

## 不建議剪除的疑似項目

- `src/web/admin/store.ts`、`login/store.ts`、`session-view/store.ts` 雖短，但各自封裝 TTL、domain-specific create signature 與 token replacement policy，符合既有 token-store **Slot**，不是無意義 thin wrapper。
- `provider-models.ts` 的 OpenAI/Anthropic fetch 外觀相似，但 headers、response contract 與 provider policy不同；目前共用 `fetchWithTimeout` 已是合理邊界，不建議為少量行數再抽象。
- `createSessionViewResponseContext.uploadFile: async () => {}` 是 adapter capability 的明確 no-op，不是未接線 function；刪除會破壞 `ConversationResponder` 介面。

## 預估總量

- **safe 可直接剪除/合併**：約 **77-96 行**。
- **含 confirm 類重構**：約 **166-242 行**。
- 最大的確定性剪枝是兩個未接線 admin endpoint；最大的介面風險是 inline `onclick` 的 context 錯誤 escaping，以及 JSON object-root 未驗證。

## 已審檔案清單

- `src/web/README.md`
- `src/web/types.ts`
- `src/web/token-store.ts`
- `src/web/portal-shell.ts`
- `src/web/server.ts`
- `src/web/admin/README.md`
- `src/web/admin/types.ts`
- `src/web/admin/store.ts`
- `src/web/admin/provider-models.ts`
- `src/web/admin/portal.ts`
- `src/web/login/README.md`
- `src/web/login/types.ts`
- `src/web/login/store.ts`
- `src/web/login/oauth.ts`
- `src/web/login/portal.ts`
- `src/web/session-view/README.md`
- `src/web/session-view/types.ts`
- `src/web/session-view/store.ts`
- `src/web/session-view/service.ts`
- `src/web/session-view/portal.ts`
