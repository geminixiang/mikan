---
title: Portal 驗證與 capability 模型
description: Harness Web Client 與獨立 portal 的身分驗證及權限邊界。
---

Mikan 同時提供一個經身分驗證的完整網站，以及三個互相獨立的 bearer-capability portals。它們共用 HTTP server，但不共用權限、導覽或前端狀態。

## 四種 Web 權限

| 介面                | 取得方式                                                                | 可做的事                                                                                                                                      | 生命週期／持久性                                                                                         |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Harness Web Client  | 先在 private chat 執行一次 `/login web`，再於 `/login` 使用 GitHub 登入 | 只建立與操作該 GitHub principal 擁有的 `platform=web` Conversation offices；讀取 transcript、prompt、取消精確 run、選擇 model／thinking level | Cookie：24 小時、只存在記憶體。完成的 admission binding：持久化於 State dir 私有檔案 `web-bindings.json` |
| Admin portal        | `/admin` 或 `/pi-admin`                                                 | 管理 deployment 與 conversations，包括 settings、models、sandbox policy、events 與產生連結                                                    | 30 分鐘、memory-only bearer token                                                                        |
| Login／vault portal | `/login`、`/pi-login`，或由 Admin 產生                                  | 將 API key 或 OAuth credential 寫入一個 scoped vault                                                                                          | 15 分鐘、memory-only bearer token；成功寫入後即消耗                                                      |
| Session View portal | `session`、`/session`，或由 Admin 產生                                  | 檢視一個 scoped Harness session 與關聯；若有 interactive wiring，可向同一 session 送出訊息                                                    | 24 小時、memory-only bearer token                                                                        |

## Harness Web Client

網站擁有 `/`、`/login` 與 `/conversations/:officeKey`。它是 daemon 的完整 client，不是 portal 外殼。

### Admission 與登入

1. 使用者在 private platform conversation 執行 `/login web`，取得五分鐘 proof code。
2. `/binding` 完成 GitHub OAuth，並以不可變的 numeric principal `github:<id>` 儲存；可變的 GitHub login 只作為顯示名稱。
3. 已完成的 admission bindings 持久化於 `web-bindings.json`；尚未完成的 proof codes 留在記憶體。
4. 後續 GitHub 登入只允許已 admitted principal，並簽發 `mikan_session` httpOnly、`SameSite=Lax` cookie；HTTPS 回應也會加上 `Secure`。

用來 admission 的 Slack、Discord、Telegram 或 GitHub office 不是網站授權，也不會由 Harness API 回傳。它只證明該 OAuth principal 是從既有 private conversation 被邀請進來。

### Web Conversation 所有權

每個網站 conversation 都是第一級 `platform=web` Conversation office。它的 raw id 由隨機 nonce 與 keyed owner digest 組成。Daemon 透過私有 `web-harness.key` 與 Office registry，只列舉目前 principal 擁有的 offices；不建立第二份 conversation inventory。Browser 可見的 OfficeKey readable segment 只包含隨機 prefix，不含穩定 owner digest，也不回傳 host path。

Browser mutation 會重複 daemon 簽發的 office key 與完整持久 Session UUID；Cancel 還會帶目前 run id。因此 stale tab 無法寫入被替換的 session，也不能取消後來的 run。

### Browser protocol

| Route                    | Method      | 驗證                                          | 用途                                                                                      |
| ------------------------ | ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/api/me`                | `GET`       | `mikan_session`                               | 回傳目前 OAuth principal 與到期時間                                                       |
| `/api/logout`            | `POST` JSON | `mikan_session` + JSON／same-origin CSRF 檢查 | 撤銷 browser session 並清除 cookie                                                        |
| `/api/harness/bootstrap` | `GET`       | `mikan_session`                               | 回傳 owned Conversation summaries、選取中的 transcript、models、run state 與 event cursor |
| `/api/harness/command`   | `POST` JSON | `mikan_session` + JSON／same-origin CSRF 檢查 | 建立 Conversation、prompt、取消精確 run、切換 model／thinking level                       |
| `/api/harness/events`    | `GET` SSE   | `mikan_session`                               | 依 epoch／sequence resume principal-scoped ordered events                                 |

Browser 只把連續 events fold 成暫時的 live state。Sequence gap、過期 replay cursor 或 daemon restart 都會觸發新的 bootstrap；run settlement 後，以 SessionStore 的持久 transcript 取代 streamed text。

舊 `/api/offices` 與 cookie → Session View token bridge 已移除。未知 `/api/*` 一律回傳 JSON `404`，不會回傳 SPA document。

## Capability portals

Portal URL 本身就是 bearer capability。Query token 可能經由 browser history、截圖、複製 URL 或 proxy logs 外洩，只能分享給預期接收者。

`/session`、`/admin`、`/link` prefixes 一律在 static fallback 之前註冊，絕不渲染 Harness Web Client。Website cookie 不能當成 portal token，portal token 也不能驗證 Harness APIs。

| Route family                                      | Token 檢查                                   | Mutation 行為                                                                               |
| ------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/admin`、`/admin/api/*`                          | `InMemoryAdminTokenStore.peek()`             | 到期前可重複使用；Admin API 可修改 settings 與產生 links                                    |
| `/link`、`/api/link/*`、vault-mode `/oauth/*`     | `InMemoryLinkTokenStore.peek()`／`consume()` | Credential JSON writes 須通過 CSRF；成功寫入後消耗 token                                    |
| `/session`、`/session/stream`、`/session/message` | `InMemorySessionViewTokenStore.peek()`       | View／SSE 可重複使用；只有 runtime／bot wiring 存在時才能送訊息，且目標固定在 token session |
| `/binding`、`/api/binding/info`                   | 五分鐘 pending binding code                  | 只完成 OAuth admission，不授予 office capability                                            |

## 為何不能共用一種 token

- Browser cookie 是 principal-owned Web Conversations 的可重用身分，不是 operator 或 secret-writing 權限。
- Admin 能改變 deployment 行為，因此必須保留明確、短效的 capability。
- Login／vault link 能寫入 secrets，成功後必須 one-time consume。
- Session View link 可獨立分享，且僅限一個 session，即使啟用 message submission 也不會擴權。

若合併權限，複製到的 session link 可能變成 credential／Admin grant，或一般網站登入可能意外繼承 ambient operator authority。

## 實作位置

| 責任                                  | 程式碼                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| Harness host、ownership、runs、replay | `src/web/harness/`                                          |
| Daemon／browser wire contract         | `packages/harness-web-contract/`                            |
| React-free browser runtime 與 UI      | `packages/web-client/`、`apps/web/`                         |
| Route ordering 與 static fallback     | `src/web/server.ts`、`packages/web-host/`                   |
| OAuth admission 與 browser sessions   | `src/web/login/portal.ts`、`binding.ts`、`session-store.ts` |
| Admin capability portal               | `src/web/admin/`                                            |
| Login／vault capability portal        | `src/web/login/`                                            |
| Session View capability portal        | `src/web/session-view/`                                     |
| 共用短效 token base                   | `src/web/token-store.ts`                                    |

`startWebServer()` 依序註冊 health／webhook、Harness APIs、capability portals、binding routes、unknown-API guard，最後才是唯一的 Vite static fallback。設定 `LINK_PORT`／`MIKAN_LINK_PORT` 時啟動；若只設定公開 link URL，預設使用 `8181`。
