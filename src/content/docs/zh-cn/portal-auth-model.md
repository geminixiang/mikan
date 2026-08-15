---
title: Portal 认证与 capability 模型
description: Harness Web Client 与独立 portal 的身份验证和权限边界。
---

Mikan 同时提供一个经过身份验证的完整网站，以及三个彼此独立的 bearer-capability portals。它们共用 HTTP server，但不共用权限、导航或前端状态。

## 四种 Web 权限

| 界面                | 获取方式                                                                | 可以执行的操作                                                                                                                                | 生命周期／持久性                                                                                       |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Harness Web Client  | 先在 private chat 执行一次 `/login web`，再于 `/login` 使用 GitHub 登录 | 只创建和操作该 GitHub principal 拥有的 `platform=web` Conversation offices；读取 transcript、prompt、取消精确 run、选择 model／thinking level | Cookie：24 小时、仅在内存中。完成的 admission binding：持久化于 State dir 私有文件 `web-bindings.json` |
| Admin portal        | `/admin` 或 `/pi-admin`                                                 | 管理 deployment 与 conversations，包括 settings、models、sandbox policy、events 和生成链接                                                    | 30 分钟、memory-only bearer token                                                                      |
| Login／vault portal | `/login`、`/pi-login`，或由 Admin 生成                                  | 将 API key 或 OAuth credential 写入一个 scoped vault                                                                                          | 15 分钟、memory-only bearer token；成功写入后消费                                                      |
| Session View portal | `session`、`/session`，或由 Admin 生成                                  | 查看一个 scoped Harness session 及其关联；存在 interactive wiring 时，可以向同一 session 提交消息                                             | 24 小时、memory-only bearer token                                                                      |

## Harness Web Client

网站拥有 `/`、`/login` 和 `/conversations/:officeKey`。它是 daemon 的完整 client，不是 portal 外壳。

### Admission 与登录

1. 用户在 private platform conversation 执行 `/login web`，获得五分钟 proof code。
2. `/binding` 完成 GitHub OAuth，并存储不可变的 numeric principal `github:<id>`；可变的 GitHub login 仅作为显示名称。
3. 已完成的 admission bindings 持久化于 `web-bindings.json`；未完成的 proof codes 留在内存中。
4. 后续 GitHub 登录只允许已 admitted principal，并签发 `mikan_session` httpOnly、`SameSite=Lax` cookie；HTTPS 响应还会加上 `Secure`。

用于 admission 的 Slack、Discord、Telegram 或 GitHub office 不是网站授权，也不会由 Harness API 返回。它只证明该 OAuth principal 是从已有 private conversation 被邀请进来的。

### Web Conversation 所有权

每个网站 conversation 都是一级 `platform=web` Conversation office。其 raw id 由随机 nonce 和 keyed owner digest 组成。Daemon 通过私有 `web-harness.key` 与 Office registry，只枚举当前 principal 拥有的 offices；不会创建第二份 conversation inventory。Browser 可见的 OfficeKey readable segment 只包含随机 prefix，不含稳定 owner digest，也不会返回 host path。

Browser mutation 会重复 daemon 签发的 office key 和完整持久 Session UUID；Cancel 还会携带当前 run id。因此 stale tab 无法写入已替换的 session，也不能取消后续 run。

### Browser protocol

| Route                    | Method      | 验证                                          | 用途                                                                                    |
| ------------------------ | ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/api/me`                | `GET`       | `mikan_session`                               | 返回当前 OAuth principal 和过期时间                                                     |
| `/api/logout`            | `POST` JSON | `mikan_session` + JSON／same-origin CSRF 检查 | 撤销 browser session 并清除 cookie                                                      |
| `/api/harness/bootstrap` | `GET`       | `mikan_session`                               | 返回 owned Conversation summaries、选中的 transcript、models、run state 和 event cursor |
| `/api/harness/command`   | `POST` JSON | `mikan_session` + JSON／same-origin CSRF 检查 | 创建 Conversation、prompt、取消精确 run、切换 model／thinking level                     |
| `/api/harness/events`    | `GET` SSE   | `mikan_session`                               | 按 epoch／sequence resume principal-scoped ordered events                               |

Browser 只把连续 events fold 成临时 live state。Sequence gap、过期 replay cursor 或 daemon restart 都会触发新的 bootstrap；run settlement 后，以 SessionStore 的持久 transcript 替换 streamed text。

旧 `/api/offices` 和 cookie → Session View token bridge 已删除。未知 `/api/*` 一律返回 JSON `404`，不会返回 SPA document。

## Capability portals

Portal URL 本身就是 bearer capability。Query token 可能通过 browser history、截图、复制 URL 或 proxy logs 泄露，只能分享给预期接收者。

`/session`、`/admin`、`/link` prefixes 始终在 static fallback 之前注册，绝不会渲染 Harness Web Client。Website cookie 不能作为 portal token，portal token 也不能验证 Harness APIs。

| Route family                                      | Token 检查                                   | Mutation 行为                                                                                 |
| ------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/admin`、`/admin/api/*`                          | `InMemoryAdminTokenStore.peek()`             | 过期前可重复使用；Admin API 可以修改 settings 和生成 links                                    |
| `/link`、`/api/link/*`、vault-mode `/oauth/*`     | `InMemoryLinkTokenStore.peek()`／`consume()` | Credential JSON writes 必须通过 CSRF；成功写入后消费 token                                    |
| `/session`、`/session/stream`、`/session/message` | `InMemorySessionViewTokenStore.peek()`       | View／SSE 可重复使用；只有存在 runtime／bot wiring 时才能提交消息，并始终限制在 token session |
| `/binding`、`/api/binding/info`                   | 五分钟 pending binding code                  | 仅完成 OAuth admission，不授予 office capability                                              |

## 为什么不能共用一种 token

- Browser cookie 是 principal-owned Web Conversations 的可复用身份，不是 operator 或 secret-writing 权限。
- Admin 可以改变 deployment 行为，因此必须保留明确、短效的 capability。
- Login／vault link 可以写入 secrets，成功后必须 one-time consume。
- Session View link 可以独立分享，并且只限一个 session；即使启用 message submission 也不会扩大权限。

如果合并权限，复制到的 session link 可能变成 credential／Admin grant，或普通网站登录可能意外继承 ambient operator authority。

## 实现位置

| 职责                                  | 代码                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| Harness host、ownership、runs、replay | `src/web/harness/`                                          |
| Daemon／browser wire contract         | `packages/harness-web-contract/`                            |
| React-free browser runtime 与 UI      | `packages/web-client/`、`apps/web/`                         |
| Route ordering 与 static fallback     | `src/web/server.ts`、`packages/web-host/`                   |
| OAuth admission 与 browser sessions   | `src/web/login/portal.ts`、`binding.ts`、`session-store.ts` |
| Admin capability portal               | `src/web/admin/`                                            |
| Login／vault capability portal        | `src/web/login/`                                            |
| Session View capability portal        | `src/web/session-view/`                                     |
| 共用短效 token base                   | `src/web/token-store.ts`                                    |

`startWebServer()` 依次注册 health／webhook、Harness APIs、capability portals、binding routes、unknown-API guard，最后才是唯一的 Vite static fallback。配置 `LINK_PORT`／`MIKAN_LINK_PORT` 时启动；如果只配置公开 link URL，默认使用 `8181`。
