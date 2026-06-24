---
title: Portal 驗證與 capability 模型
---

# Portal 驗證與 capability 模型

本文說明 mikan 目前的 web 介面，以及它們使用的 token 模型。這份文件刻意採描述性寫法：它記錄目前程式碼中已存在的行為，讓未來 dashboard/refactor 工作能保留正確的風險邊界。

最短講法：

- **Admin token**：控制台能力。能看/改設定，也能產生其他 link，但不能直接寫 secret。
- **Login / link token**：寫入 secret 的一次性能力。短效，完成寫入或 OAuth callback 後消耗。
- **Session view token**：檢視 session 的能力；目前也能在 interactive wiring 可用時送訊息回 session。

```text
/admin  ── Admin token ──> settings / workspace / link generation
/link   ── Link token  ──> vault secret writes / OAuth completion
/session── View token  ──> timeline view / optional session message
```

## Web 介面

mikan 目前從 `src/web/login/portal.ts` 中由 `startLinkServer()` 啟動的 link server，暴露三個相關但不同的瀏覽器介面：

| 介面                 | 主要路由                                                             | 指令入口                                                            | 用途                                                                                       | 風險等級 | Token store                                         |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------- |
| Admin portal         | `/admin`, `/admin/api/*`                                             | `/admin` / `/pi-admin`                                              | 管理 conversations、設定、workspace previews、skills、events，並產生 session/login links。 | 中高     | `InMemoryAdminTokenStore`                           |
| Login / vault portal | `/link`, `/api/link/complete`, `/api/oauth/start`, `/oauth/callback` | `/login` / `/pi-login` 或 admin 產生的 login link                   | 將 API keys 與 OAuth credentials 儲存到 vault。                                            | 最高     | `InMemoryLinkTokenStore` 加上短生命週期 OAuth state |
| Session view         | `/session`, `/session/stream`, `/session/message`                    | `session` / `/session` / `/pi-session` 或 admin 產生的 session link | 檢視 session timeline，並在 interactive wiring 可用時，將訊息送回該 session。              | 中       | `InMemorySessionViewTokenStore`                     |

這三個介面透過 `src/portal-shell.ts` 共用視覺外殼，但它們刻意不共用同一個 authorization token。換句話說：**同一個 web server、同一套 UI shell、三種不同 capability**。

## 目前的伺服器 ownership

`src/web/login/portal.ts` 目前擁有 HTTP server，雖然它也包含 login/vault 專用程式碼。dispatch 順序如下：

1. `GET /health`
2. 設定 admin token store 時，透過 `handleAdminRequest()` 處理 admin routes
3. 透過 `handleSessionViewRequest()` 處理 Session view routes
4. Login/vault routes（`/link`, `/api/link/complete`, `/api/oauth/start`, `/oauth/callback`）
5. `404`

這表示 module 名稱比它實際的責任範圍更窄：它同時是 link/login portal，也是 portal host。

只有當 `src/main.ts` 中的 `LINK_PORT`（或透過 `readEnv` 的 `MIKAN_LINK_PORT`）解析成 port 時，server 才會啟動。如果設定了 `LINK_URL` / `MIKAN_LINK_URL` 但沒有設定明確 port，mikan 會預設使用 port `8181`。

## Token 類型

### Admin token

位置：`src/web/admin/types.ts` 定義 `AdminToken`，`src/web/admin/store.ts` 的 `InMemoryAdminTokenStore` 負責儲存與簽發。

目前屬性：

- `token`
- `platform`
- `platformUserId`
- optional `platformUserName`
- `conversationId`
- `expiresAt`

目前行為：

- TTL：30 分鐘。
- 查詢方法：`peek(rawToken)`。
- 使用時不會消耗。
- 為相同 `(platform, platformUserId)` 建立新的 admin token，會讓該使用者先前的 admin token 失效。
- 由 `/admin` 與所有 `/admin/api/*` route 使用。

目前 capability：

- 讀取 admin page identity（`/admin/api/me`）。
- 從設定的 working directory 列出 conversations。
- 讀取/更新 conversation model、thinking level、sandbox mount 與 auto-reply settings。
- 讀取/更新 global model 與 sandbox defaults。
- 讀取 exposed paths 底下有限的 conversation workspace files。
- 讀取 skills 與 events metadata/files。
- 刪除與所選 conversation 關聯的 events。
- 為目標 conversation 產生 session view links 與 login/vault links。

重要邊界：

- Admin token 可以產生 login link，但它本身不會把 secret values 寫入 vault。Secret writes 仍會經過 login/vault token flow。
- Admin token 是可重複使用的短 session capability，不是 one-shot action token。

### Login / link token

位置：`src/web/login/types.ts` 定義 `LinkToken`，`src/web/login/store.ts` 的 `InMemoryLinkTokenStore` 負責儲存與簽發。

目前屬性：

- `token`
- `platform`
- `platformUserId`
- `vaultId`
- `providerId`
- `conversationId`
- `expiresAt`

目前行為：

- TTL：15 分鐘。
- 查詢方法：`peek(rawToken)`，用於 render `/link` 與啟動 OAuth。
- 消耗方法：`consume(rawToken)`，用於 credential completion 與 OAuth callback。
- 為相同 `(platform, platformUserId)` 建立新的 link token，會讓該使用者先前的 link token 失效。
- `/api/link/complete` 會在寫入 credentials 前消耗 token。
- `/oauth/callback` 會在驗證並花費 OAuth state 後消耗 token。

目前 capability：

- 為特定 vault render credential/OAuth onboarding form。
- 將環境變數與 preset/OAuth 定義的 file mounts 寫入該 vault。
- 完成支援的 OAuth flows，並持久化 tokens/credential files。
- Credential storage 成功後通知來源 conversation。

額外防護：

- Credential POST routes 要求 `Content-Type: application/json`。
- 設定 `LINK_URL` / `MIKAN_LINK_URL` 時，credential POST routes 會強制檢查 same-origin `Origin` 或 `Referer`。
- OAuth 使用獨立的 in-memory state，TTL 10 分鐘，並帶有 PKCE verifier。
- Secret values 不會重新 render 給瀏覽器；既有 vault summaries 只顯示 secret names 與 mount targets。

重要邊界：

- Link token 是高風險 action capability，不是一般 dashboard session。它應維持短生命週期，且寫入時為 one-shot。
- `peek()` 只用來顯示頁面或開始 OAuth；真正寫入 secret 的路徑使用 `consume()`。

### Session view token

位置：`src/web/session-view/types.ts` 定義 `SessionViewToken`，`src/web/session-view/store.ts` 的 `InMemorySessionViewTokenStore` 負責儲存與簽發。

目前屬性：

- `token`
- `platform`
- `platformUserId`
- optional `platformUserName`
- `conversationId`
- `sessionKey`
- `sessionFile`
- `expiresAt`

目前行為：

- TTL：24 小時。
- 查詢方法：`peek(rawToken)`。
- 使用時不會消耗。
- 由 `/session`、`/session/stream` 與 `/session/message` 使用。
- Token 錨定到 base session file，但 `/session?session=<file.jsonl>` 在驗證後，可以導覽到同一目錄中的相關 session files。

目前 capability：

- 從 structured session file render session timeline。
- 導覽 parent/thread session relationships。
- 透過 SSE 訂閱 live status/timeline updates。
- 設定 `SessionViewInteractiveOptions` 時，將訊息送入所選 session。

重要邊界：

- 目前程式碼中的 Session view 不是純 read-only，因為 `/session/message` 可以用 `session_view` event 呼叫 `handler.handleEvent()`。只要該 route 尚未停用或移除，面向使用者的文案就應避免稱它為 read-only。
- Session view 的 message/stream routes 需要 `SessionViewInteractiveOptions`；沒有 interactive wiring 時，頁面檢視可存在，但送訊息與 SSE stream 不可用。
- `/session/message` 解析 JSON body token，但不像 login credential POST routes 一樣套用 `enforceCsrf()`。這個 route 的邊界是 session view capability token 本身。

## Route-to-token 矩陣

| Route                | Method | Token 來源        | Store / state                            | 備註                                                                      |
| -------------------- | ------ | ----------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                 | Render admin portal 或 403 error page。                                   |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                 | 回傳 JSON；未授權回傳 403。                                               |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                 | 回傳 JSON；未授權回傳 403。                                               |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                  | Render login/vault page；不消耗 token。                                   |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`               | 寫入 credentials；設定時受 JSON content type 與 same-origin checks 保護。 |
| `/api/oauth/start`   | `POST` | JSON body `token` | `linkTokenStore.peek()` + OAuth state    | 啟動 OAuth；尚不消耗 link token。                                         |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + `linkTokenStore.consume()` | 花費 OAuth state 與 link token。                                          |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | Render session page。                                                     |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | 開啟 SSE stream；需要 interactive wiring。                                |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`           | 送出 `session_view` event；需要 interactive wiring；不消耗 token。        |

## 講解時可用的判斷規則

先問「這個 link 會做什麼事？」：

1. **只改設定或產生 link** → Admin token。
2. **會寫 secret / OAuth credential** → Login / link token，而且寫入時 one-shot。
3. **看 session 或從 session 頁面送訊息** → Session view token。

再問「token 被用掉嗎？」：

- Admin：不消耗，30 分鐘內可重複用。
- Login：顯示頁面不消耗；完成 credential 或 OAuth callback 會消耗。
- Session view：不消耗，24 小時內可重複用。

## 為什麼不應攤平成同一種 token

目前這些差異是刻意的風險控制：

- Admin token：中高風險的 control-plane access；可在短 session window 內重複使用。
- Link token：最高風險的 secret-write action；短生命週期，並在 write/callback 時消耗。
- Session view token：中風險的 session content/action access；為了使用便利性有較長生命週期。

未來的 dashboard 可以引入更高層級的 portal identity，但不應抹除這些邊界。特別是：

- Dashboard access 可以授權 viewing/settings operations。
- Secret writes 仍應要求短生命週期的 action capability，或等價的第二步驟。
- 即使加入 dashboard-native session viewing，standalone session links 仍可保留為 capability links。

## 已知對齊事項

- `commands.md` 應將 `session` 描述為 web session view，而不是嚴格 read-only，只要 `/session/message` 仍存在。
- `src/web/login/portal.ts` 比它的名稱更廣：它負責 host admin、session view 與 login routes。
- `src/portal-shell.ts` 只是共用 presentation，不是 auth boundary。
- Token stores 是 in-memory，並由 `src/main.ts` 每五分鐘清理一次；process 重啟會讓所有尚未過期的 web tokens 失效。
