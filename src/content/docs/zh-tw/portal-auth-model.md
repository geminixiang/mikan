---
title: Portal 驗證與 capability 模型
description: mikan Web dashboard 與 portal 使用的瀏覽器 identity 與 scoped capability 模型。
---

這樣設計的目標是：讓使用者可以方便地開啟管理、登入與 session 檢視頁面，同時避免把「看資料」、「改設定」和「寫入 secret」混成同一種權限。

## 4 種 web authority

| 介面                  | 使用者如何取得                                                | 可以做什麼                                                                                                  | 有效期  | 是否一次性 token |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------- | ---------------- |
| Web dashboard session | 用 `/login web` 綁定，再在 `/login` 使用 GitHub 登入          | 發現精確綁定的 conversation，並透過 session-view capability 開啟它。                                        | 24 小時 | 否               |
| Admin portal          | `/admin` / `/pi-admin`                                        | 管理 conversations、model、sandbox、auto-reply、workspace previews 與 events；也能產生 session/login link。 | 30 分鐘 | 否               |
| Login / vault portal  | `/login` / `/pi-login` 或由 admin portal 產生                 | 儲存 API keys，或完成內建 OAuth flow，將 credentials 寫入 vault。                                           | 15 分鐘 | 寫入時是         |
| Session view          | `session` / `/session` / `/pi-session` 或由 admin portal 產生 | 檢視 session timeline；interactive mode 可用時，也能從網頁送訊息回該 session。                              | 24 小時 | 否               |

簡化來看：

```text
/login   → private chat binding 後建立 browser identity
/admin   → 改變設定、檢視 workspace、產生其他 link
/link    → 寫入 vault secrets 或 OAuth credentials
/session → 檢視 session；也可以選擇送訊息回 session
```

React SPA 會在同一個 site 中呈現這些頁面，但它們的 authorization 刻意不互通。

## 權限邊界

### Web dashboard session

`/login web` 會在 private chat 中建立短期 binding code。完成 binding 後，會記錄 GitHub OAuth identity、platform user 與精確的 source conversation。之後使用 GitHub 登入時，只有在存在該 binding 的情況下才會收到 httpOnly 的 `mikan_session` cookie。這是一個存在記憶體中的 24 小時 web session。沒有 binding 時，登入會被拒絕。

Dashboard session 可以：

- 透過 `/api/me` 讀取自己的 identity。
- 透過 `/api/offices` 只列出自己精確綁定的 office。
- 該 office 存在 session file 時，取得它的 session-view URL。
- 透過 `/api/logout` 撤銷自己。

它不能列舉其他 office、取得 host filesystem path、授權 Admin API，或寫入 vault credentials。Binding 與 browser session 都在記憶體中，因此重啟 mikan 後必須重新 binding 並登入。

### Admin portal

Admin portal 是 control-plane access。取得 admin link 的人可以在短時間內管理 mikan 的設定與 conversation 狀態。

Admin portal 可以：

- 查看目前 user 與 conversation identity。
- 從 office registry（持久的 raw id ↔ office 對照）列出 conversations，而不是掃描 workspace。
- 讀取與更新 conversation model、thinking level、workspace door policy 與 layout、auto-reply 與 Slack reply mode。
- 讀取與更新 global model、sandbox 資源預設值、全域 door policy 與 Slack defaults。
- 檢視有限範圍的 workspace files、skills、events metadata/files，並可在任一 level 建立或編輯 skills。
- 列出並變更某個 scope 的 package sources。
- 檢視 session 與 conversation 使用量。
- 刪除所選 conversation 的 events。
- 為目標 conversation 產生 session view link 或 login/vault link。

Door policy 也可以從聊天中用 `/pi-sandbox door` 設定，但絕不會由 agent 自己設定：conversation 設定之所以放在僅限 host 的 state dir 底下，正是因為 conversation 目錄會以可讀寫的方式 bind mount 進 sandbox，而位於該 mount 內的設定檔只會被移轉一次，之後就再也不會被讀取。

Admin portal 不會直接寫入 secret values。即使從 admin portal 產生 login link，真正的 secret write 仍會走 Login / vault portal 的一次性 token flow。

### Login / vault portal

Login / vault portal 是最高風險的 action capability，因為它能寫入 credentials。

Login / vault portal 可以：

- 顯示指定 vault 的 credential 或 OAuth onboarding form。
- 將環境變數寫入該 vault。
- 依 preset 或 OAuth flow 寫入 credential files，例如支援工具需要的設定檔。
- 完成支援的 OAuth flow，並保存 access token、refresh token 或 credential file。
- 寫入成功後通知來源 conversation。

Login token 的重要行為：

- 開啟 `/link` 頁面不會消耗 token。
- 啟動 OAuth 不會消耗 token。
- 完成 credential POST 或 OAuth callback 時會消耗 token。
- 同一位 platform user 建立新的 login token 時，舊 login token 會失效。

額外保護：

- Credential POST route 要求 `Content-Type: application/json`。
- 設定 `LINK_URL` / `MIKAN_LINK_URL` 時，credential POST route 會檢查 same-origin `Origin` 或 `Referer`。
- OAuth state 獨立於 login token，TTL 為 10 分鐘，並使用 PKCE verifier。
- Secret values 不會重新 render 給瀏覽器；既有 vault summary 只顯示 secret names 與 mount targets。

### Session view

Session view 是 session content access。它主要用來檢視 structured session timeline。

Session view 可以：

- Render session timeline。
- 導覽 parent/thread session relationships。
- 透過 SSE 訂閱 live status 與 timeline updates。
- 在 interactive wiring 可用時，從網頁送訊息回所選 session。

Session view 不是純 read-only。只要 `/session/message` route 存在，而且 interactive wiring 可用，session view token 就能送出 `session_view` event 並呼叫 bot handler。

Session view token 錨定到 base session file。使用 `/session?session=<file.jsonl>` 導覽時，只能切換到同一目錄中的 session files。

## Route 與 token 對照

| Route                | Method | Authority         | 驗證方式                                          | 備註                                              |
| -------------------- | ------ | ----------------- | ------------------------------------------------- | ------------------------------------------------- |
| `/api/me`            | `GET`  | `mikan_session`   | `webSessionStore.getSessionFromCookie()`          | 回傳目前的 dashboard identity。                   |
| `/api/logout`        | `POST` | `mikan_session`   | 撤銷相符的 browser session                        | 清除 browser cookie。                             |
| `/api/offices`       | `GET`  | `mikan_session`   | 精確 session binding + office registry            | 回傳 scoped office metadata 與 session-view URL。 |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                          | Render admin portal。                             |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                          | 未授權回傳 403。                                  |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                          | 未授權回傳 403。                                  |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                           | Render login/vault page；不消耗 token。           |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`                        | 寫入 credentials；消耗 token。                    |
| `/api/oauth/start`   | `POST` | JSON body + mode  | Vault token、binding code 或 dashboard login mode | 建立 OAuth redirect 與 one-shot state。           |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + 啟動時選擇的 authority              | 完成 binding、browser login 或 vault OAuth。      |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`                    | Render session page。                             |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`                    | 開啟 SSE stream；需要 interactive wiring。        |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`                    | 送出 session message；需要 interactive wiring。   |

## 為什麼不使用同一種 token

這些 authority 的風險不同：

- Web session：綁定到精確 conversation 的可重複使用 identity，只能為自己的 session 產生 session-view capabilities。
- Admin token：可重複使用的短期管理權限。
- Login token：能寫入 secrets，所以壽命更短，且寫入時會被消耗。
- Session view token：方便分享與回看 session，因此有效期較長，但權限限於 session view 範圍。

Dashboard identity 不會合併這些邊界。Admin 變更與 secret writes 仍需要各自專用的 capability，而獨立的 session links 仍可分開分享。

## 實作位置

| 功能                 | 主要程式碼                                                        |
| -------------------- | ----------------------------------------------------------------- |
| Portal HTTP server   | `src/web/server.ts` 的 `startWebServer()`                         |
| Web dashboard login  | `src/web/login/portal.ts`、`src/web/login/session-store.ts`       |
| Admin portal         | `src/web/admin/portal.ts`、`src/web/admin/store.ts`               |
| Login / vault portal | `src/web/login/portal.ts`、`src/web/login/store.ts`               |
| Session view         | `src/web/session-view/portal.ts`、`src/web/session-view/store.ts` |
| 共用 token store     | `src/web/token-store.ts`                                          |
| React SPA            | `apps/web/`、`packages/web-client/`、`packages/ui-*`              |

`startWebServer()` 的 dispatch 順序是：

1. `GET /health`
2. Agent event HTTP routes
3. Admin routes
4. Session view routes
5. Login、binding 與 authenticated office routes
6. Static SPA fallback，否則回傳 `404`

Server 只有在 `LINK_PORT` / `MIKAN_LINK_PORT` 可解析成 port 時才會啟動。若設定了 `LINK_URL` / `MIKAN_LINK_URL` 但沒有設定 port，mikan 會使用預設 port `8181`。

Capability stores、已完成的 binding 與 browser sessions 目前都在記憶體中。Process 重啟會讓它們全部失效；capability stores 會定期 purge，而 browser sessions 也會在 lookup 時延遲 expire。

這些 URL 是 bearer capabilities。Query-string tokens 可能透過瀏覽器歷史、螢幕截圖、複製的 URL 或 proxy logs 洩漏；請僅與預期使用者分享，且絕不發布到聊天頻道或 issue trackers。
