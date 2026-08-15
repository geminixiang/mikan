---
title: Portal 身份验证和 capability 模型
description: mikan Web dashboard 和 portal 使用的浏览器身份与作用域 capability 模型。
---

设计目标是让用户能方便地打开管理、登录和会话查看页面，同时避免将“读取数据”“更改设置”和“写入机密”混入一种权限。

## 四种 Web authority

| 界面                  | 用户如何获取                                                   | 可以执行的操作                                                              | 有效期  | 是否为一次性 token？ |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- | ------- | -------------------- |
| Web dashboard session | 通过 `/login web` 绑定，然后在 `/login` 使用 GitHub 登录       | 发现精确绑定的对话，并通过会话视图 capability 打开它。                      | 24 小时 | 否                   |
| Admin portal          | `/admin` / `/pi-admin`                                         | 管理对话、模型、沙箱、自动回复、工作区预览和事件；还可以生成会话/登录链接。 | 30 分钟 | 否                   |
| Login / vault portal  | `/login` / `/pi-login`，或由 Admin portal 生成                 | 存储 API key 或完成内置 OAuth 流程，将凭证写入 vault。                      | 15 分钟 | 是，写入时使用       |
| Session view          | `session` / `/session` / `/pi-session`，或由 Admin portal 生成 | 查看会话时间线；交互模式可用时，还可以从网页向该会话发送消息。              | 24 小时 | 否                   |

简而言之：

```text
/login   → 私聊绑定后建立浏览器身份
/admin   → 更改设置、查看工作区、生成其他链接
/link    → 写入 vault 机密或 OAuth 凭证
/session → 查看会话；也可以选择向会话发送消息
```

React SPA 在同一个站点中呈现这些页面，但它们的授权有意不相互通用。

## 权限边界

### Web dashboard session

`/login web` 会在私聊中创建短期绑定码。完成绑定后，会记录 GitHub OAuth 身份、平台用户和精确的来源对话。之后使用 GitHub 登录时，只有在存在该绑定的情况下才会收到 httpOnly `mikan_session` cookie。这是一个保存在内存中的 24 小时 Web session。没有绑定时，登录会被拒绝。

Dashboard session 可以：

- 通过 `/api/me` 读取自己的身份。
- 通过 `/api/offices` 只列出自己精确绑定的 office。
- 当该 office 存在 session 文件时，接收它的会话视图 URL。
- 通过 `/api/logout` 撤销自己。

它不能列出其他 office，不能获得主机文件系统路径，不能授权 Admin API，也不能写入 vault 凭证。绑定和浏览器 session 都位于内存中，因此重启 mikan 后需要重新绑定并登录。

### Admin portal

Admin portal 是控制平面访问权限。任何获得管理链接的人都可以在短时间内管理 mikan 设置和对话状态。

Admin portal 可以：

- 查看当前用户和对话身份。
- 从 office registry（持久的原始 id ↔ office 映射）列出对话，而不是扫描工作区。
- 读取和更新对话模型、思考级别、工作区门禁策略与布局、自动回复和 Slack 回复模式。
- 读取和更新全局模型、沙箱资源默认值、全局门禁策略和 Slack 默认值。
- 查看有限范围的工作区文件、技能和事件元数据/文件，并在任一层级创建或编辑技能。
- 列出和修改某个范围的 package 来源。
- 查看会话和对话用量。
- 删除所选对话的事件。
- 为目标对话生成会话视图链接或登录/vault 链接。

门禁策略也可以在聊天中用 `/pi-sandbox door` 设置，但绝不能由代理自己设置：对话设置之所以位于仅主机的 state dir 下，正是因为对话目录会以可读写方式 bind-mount 进沙箱，而 mount 内部的设置文件只会被迁移一次，之后再也不会被读取。

Admin portal 不会直接写入机密值。即使它生成登录链接，真正的机密写入仍通过 Login / vault portal 的一次性 token 流程进行。

### Login / vault portal

Login / vault portal 是风险最高的操作 capability，因为它可以写入凭证。

Login / vault portal 可以：

- 显示指定 vault 的凭证或 OAuth 引导表单。
- 将环境变量写入该 vault。
- 从 preset 或 OAuth 流程写入凭证文件，例如受支持工具所需的配置文件。
- 完成受支持的 OAuth 流程并保存 access token、refresh token 或凭证文件。
- 成功写入后通知来源对话。

登录 token 的重要行为：

- 打开 `/link` 页面不会使用 token。
- 启动 OAuth 不会使用 token。
- 完成凭证 POST 或 OAuth callback 会使用 token。
- 同一平台用户创建新的登录 token 时，旧登录 token 会失效。

额外保护：

- 凭证 POST 路由要求 `Content-Type: application/json`。
- 设置 `LINK_URL` / `MIKAN_LINK_URL` 时，凭证 POST 路由会检查同源 `Origin` 或 `Referer`。
- OAuth state 独立于登录 token，有效期为 10 分钟，并使用 PKCE verifier。
- 机密值不会重新渲染到浏览器；现有 vault 摘要只显示机密名称和挂载目标。

### Session view

Session view 是会话内容访问权限，主要用于查看结构化会话时间线。

Session view 可以：

- 渲染会话时间线。
- 浏览父/话题会话关系。
- 通过 SSE 订阅实时状态和时间线更新。
- 交互 wiring 可用时，从网页向所选会话发送消息。

Session view 并非完全只读。只要存在 `/session/message` 路由且交互 wiring 可用，会话视图 token 就可以发送 `session_view` 事件并调用 bot handler。

Session view token 锚定到基础会话文件。使用 `/session?session=<file.jsonl>` 浏览时，只能切换到同一目录中的会话文件。

## 路由和 token 对照

| 路由                 | 方法   | Authority         | 验证                                       | 说明                                         |
| -------------------- | ------ | ----------------- | ------------------------------------------ | -------------------------------------------- |
| `/api/me`            | `GET`  | `mikan_session`   | `webSessionStore.getSessionFromCookie()`   | 返回当前 dashboard 身份。                    |
| `/api/logout`        | `POST` | `mikan_session`   | 撤销匹配的浏览器 session                   | 清除浏览器 cookie。                          |
| `/api/offices`       | `GET`  | `mikan_session`   | 精确 session binding + office registry     | 返回有作用域的 office 元数据和会话视图 URL。 |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                   | 渲染 Admin portal。                          |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                   | 未授权时返回 403。                           |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                   | 未授权时返回 403。                           |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                    | 渲染登录/vault 页面；不使用 token。          |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`                 | 写入凭证；使用 token。                       |
| `/api/oauth/start`   | `POST` | JSON body + mode  | Vault token、绑定码或 dashboard login mode | 创建 OAuth redirect 和一次性 state。         |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state 加上启动时选择的 authority     | 完成绑定、浏览器登录或 vault OAuth。         |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`             | 渲染会话页面。                               |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`             | 打开 SSE stream；需要交互 wiring。           |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`             | 发送会话消息；需要交互 wiring。              |

## 为什么不使用一种 token 类型

这些 authority 的风险不同：

- Web session：绑定到精确对话的可复用身份，只能为自身生成会话视图 capability。
- Admin token：可重复使用的短期管理权限。
- Login token：可以写入机密，因此有效期更短，并在写入时被使用。
- Session view token：适合共享和审查会话，因此有效期更长，但权限仅限会话视图范围。

Dashboard 身份不会合并这些边界。Admin 更改和机密写入仍需要各自专用的 capability，而独立会话链接仍可单独共享。

## 实现位置

| 功能                | 主要代码                                                          |
| ------------------- | ----------------------------------------------------------------- |
| Portal HTTP 服务器  | `src/web/server.ts` 中的 `startWebServer()`                       |
| Web dashboard 登录  | `src/web/login/portal.ts`、`src/web/login/session-store.ts`       |
| Admin portal        | `src/web/admin/portal.ts`、`src/web/admin/store.ts`               |
| 登录 / vault portal | `src/web/login/portal.ts`、`src/web/login/store.ts`               |
| Session view        | `src/web/session-view/portal.ts`、`src/web/session-view/store.ts` |
| 共享 token store    | `src/web/token-store.ts`                                          |
| React SPA           | `apps/web/`、`packages/web-client/`、`packages/ui-*`              |

`startWebServer()` 的分发顺序：

1. `GET /health`
2. Agent event HTTP routes
3. Admin routes
4. Session view routes
5. Login、binding 和已认证 office routes
6. Static SPA fallback，否则返回 `404`

服务器仅在 `LINK_PORT` / `MIKAN_LINK_PORT` 可以解析为端口时启动。如果设置了 `LINK_URL` / `MIKAN_LINK_URL` 但未配置端口，mikan 使用默认端口 `8181`。

Capability store、已完成的绑定和浏览器 session 目前都位于内存中。进程重启会使它们全部失效；capability store 会定期清理，而浏览器 session 也会在查找时延迟过期。

这些 URL 是 bearer capability。Query-string token 可能通过浏览器历史记录、截图、复制的 URL 或代理日志泄露；请只与预期用户共享，绝不要发布到聊天频道或 issue tracker 中。
