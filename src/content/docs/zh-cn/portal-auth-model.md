---
title: Portal 验证与 capability 模型
description: mikan admin、login 与 session portal 使用的短期 capability token 权限模型。
---

这样设计的目标是：让使用者可以方便地开启管理、登入与 session 检视页面，同时避免把「看资料」、「改设定」和「写入 secret」混成同一种权限。

## 三种 portal link

| 介面                 | 使用者如何取得                                                 | 可以做什么                                                                                                | Token 有效期 | Token 是否一次性 |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| Admin portal         | `/admin` / `/pi-admin`                                         | 管理 conversations、模型、sandbox、auto-reply、workspace previews、events。也能产生 session/login links。 | 30 分钟      | 否               |
| Login / vault portal | `/login` / `/pi-login`，或由 admin portal 产生                 | 储存 API keys，或完成内建 OAuth flow，将 credentials 写入 vault。                                         | 15 分钟      | 写入时是         |
| Session view         | `session` / `/session` / `/pi-session`，或由 admin portal 产生 | 检视 session timeline；互动模式可用时，也能从网页送讯息回该 session。                                     | 24 小时      | 否               |

简化来看：

```text
/admin   → 改設定、看 workspace、產生其他 link
/link    → 寫入 vault secrets 或 OAuth credentials
/session → 看 session；可選擇性送訊息回 session
```

这三个页面共用同一套 portal 外观，但不共用同一个 authorization token。

## 权限边界

### Admin portal

Admin portal 是 control-plane access。拿到 admin link 的人可以在短时间内管理 mikan 的设定与 conversation 状态。

Admin portal 可以：

- 查看目前使用者与 conversation identity。
- 列出 working directory 中的 conversations。
- 读取与更新 conversation model、thinking level、sandbox mount、auto-reply 与 Slack reply mode。
- 读取与更新 global model、sandbox defaults 与 Slack defaults。
- 检视有限范围的 workspace files、skills、events metadata/files。
- 删除所选 conversation 的 events。
- 为目标 conversation 产生 session view link 或 login/vault link。

Admin portal 不会直接写入 secret values。即使从 admin portal 产生 login link，真正的 secret write 仍会走 Login / vault portal 的一次性 token flow。

### Login / vault portal

Login / vault portal 是最高风险的 action capability，因为它能写入 credentials。

Login / vault portal 可以：

- 显示指定 vault 的 credential 或 OAuth onboarding form。
- 将环境变数写入该 vault。
- 依 preset 或 OAuth flow 写入 credential files，例如支援工具需要的设定档。
- 完成支援的 OAuth flow，并保存 access token、refresh token 或 credential file。
- 写入成功后通知来源 conversation。

Login token 的重要行为：

- 开启 `/link` 页面不会消耗 token。
- 启动 OAuth 不会消耗 token。
- 完成 credential POST 或 OAuth callback 时会消耗 token。
- 同一位 platform user 建立新的 login token 时，旧 login token 会失效。

额外保护：

- Credential POST routes 要求 `Content-Type: application/json`。
- 设定 `LINK_URL` / `MIKAN_LINK_URL` 时，credential POST routes 会检查 same-origin `Origin` 或 `Referer`。
- OAuth state 独立于 login token，TTL 为 10 分钟，并使用 PKCE verifier。
- Secret values 不会重新 render 给浏览器；既有 vault summaries 只显示 secret names 与 mount targets。

### Session view

Session view 是 session content access。它主要用来检视 structured session timeline。

Session view 可以：

- Render session timeline。
- 导览 parent/thread session relationships。
- 透过 SSE 订阅 live status 与 timeline updates。
- 在 interactive wiring 可用时，从网页送讯息回所选 session。

Session view 不是纯 read-only。只要 `/session/message` route 存在，而且 interactive wiring 可用，session view token 就能送出 `session_view` event 并呼叫 bot handler。

Session view token 锚定到 base session file。使用 `/session?session=<file.jsonl>` 导览时，只能切换到同一目录中的 session files。

## Route 与 token 对照

| Route                | Method | Token 来源        | 验证方式                                 | 备注                                            |
| -------------------- | ------ | ----------------- | ---------------------------------------- | ----------------------------------------------- |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                 | Render admin portal。                           |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                 | 未授权回传 403。                                |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                 | 未授权回传 403。                                |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                  | Render login/vault page；不消耗 token。         |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`               | 写入 credentials；消耗 token。                  |
| `/api/oauth/start`   | `POST` | JSON body `token` | `linkTokenStore.peek()` + OAuth state    | 建立 OAuth redirect；尚不消耗 login token。     |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + `linkTokenStore.consume()` | 完成 OAuth；消耗 OAuth state 与 login token。   |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | Render session page。                           |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | 开启 SSE stream；需要 interactive wiring。      |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`           | 送出 session message；需要 interactive wiring。 |

## 为什么不使用同一种 token

这三种 token 对应的风险不同：

- Admin token：可重复使用的短期管理权限。
- Login token：能写入 secrets，所以寿命更短，且写入时会被消耗。
- Session view token：方便分享与回看 session，因此有效期较长，但权限限于 session view 范围。

未来即使加入完整 dashboard，也应保留这些边界：

- Dashboard identity 可以授权检视与设定操作。
- Secret writes 仍应要求短生命周期的一次性 capability，或等价的二次确认。
- Standalone session links 仍可作为 session viewing 的 capability links。

## 实作位置

| 功能                 | 主要程式码                                                        |
| -------------------- | ----------------------------------------------------------------- |
| Portal HTTP server   | `src/web/server.ts` 的 `startWebServer()`                         |
| Admin portal         | `src/web/admin/portal.ts`、`src/web/admin/store.ts`               |
| Login / vault portal | `src/web/login/portal.ts`、`src/web/login/store.ts`               |
| Session view         | `src/web/session-view/portal.ts`、`src/web/session-view/store.ts` |
| 共用 token store     | `src/web/token-store.ts`                                          |
| 共用 portal shell    | `src/portal-shell.ts`                                             |

`startWebServer()` 的 dispatch 顺序是：

1. `GET /health`
2. Admin routes
3. Session view routes
4. Login / vault routes
5. `404`

Server 只有在 `LINK_PORT` / `MIKAN_LINK_PORT` 可解析成 port 时才会启动。若设定了 `LINK_URL` / `MIKAN_LINK_URL` 但没有设定 port，mikan 会使用预设 port `8181`。

Token stores 目前都是 in-memory，并由 `src/main.ts` 每五分钟清理过期 token。Process 重启会让尚未过期的 web tokens 全部失效。
