---
title: Portal 身份验证和 capability 模型
description: mikan 管理、登录和会话 portal 使用的短期 capability token 权限模型。
---

设计目标是让用户能方便地打开管理、登录和会话查看页面，同时避免将“读取数据”“更改设置”和“写入机密”混入一种权限。

## 三种 portal 链接

| 界面                | 用户如何获取                                                 | 可以执行的操作                                                              | Token 有效期 | 是否为一次性 token？ |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------ | -------------------- |
| 管理 portal         | `/admin` / `/pi-admin`                                       | 管理对话、模型、沙箱、自动回复、工作区预览和事件。还可以生成会话/登录链接。 | 30 分钟      | 否                   |
| 登录 / vault portal | `/login` / `/pi-login`，或由管理 portal 生成                 | 存储 API key 或完成内置 OAuth 流程，将凭证写入 vault。                      | 15 分钟      | 是，写入时使用       |
| 会话视图            | `session` / `/session` / `/pi-session`，或由管理 portal 生成 | 查看会话时间线；交互模式可用时，还可以从网页向该会话发送消息。              | 24 小时      | 否                   |

简而言之：

```text
/admin   → change settings, view workspace, generate other links
/link    → write vault secrets or OAuth credentials
/session → view session; optionally send messages back to the session
```

这三个页面共享同一个 portal shell，但不共享 authorization token。

## 权限边界

### 管理 portal

管理 portal 是控制平面访问权限。任何获得管理链接的人都可以在短时间内管理 mikan 设置和对话状态。

管理 portal 可以：

- 查看当前用户和对话身份
- 从办公室注册表（持久的原始 id ↔ 办公室映射）列出对话，而不是扫描工作区
- 读取和更新对话模型、思考级别、工作区门禁策略与布局、自动回复和 Slack 回复模式
- 读取和更新全局模型、沙箱资源默认值、全局门禁策略和 Slack 默认值
- 查看有限范围的工作区文件、技能和事件元数据/文件，并在任一层级创建或编辑技能
- 列出和修改某个范围的 package 来源
- 查看会话和对话用量
- 删除所选对话的事件
- 为目标对话生成会话视图链接或登录/vault 链接

门禁策略也可以在聊天中用 `/pi-sandbox door` 设置，但绝不能由代理自己设置：对话设置之所以位于仅主机的 state dir 下，正是因为对话目录会以可读写方式 bind-mount 进沙箱，而 mount 内部的设置文件只会被迁移一次，之后再也不会被读取。

管理 portal 不会直接写入机密值。即使它生成登录链接，真正的机密写入仍通过登录 / vault portal 的一次性 token 流程进行。

### 登录 / vault portal

登录 / vault portal 是风险最高的操作 capability，因为它可以写入凭证。

登录 / vault portal 可以：

- 显示指定 vault 的凭证或 OAuth 引导表单
- 将环境变量写入该 vault
- 从 preset 或 OAuth 流程写入凭证文件，例如受支持工具所需的配置文件
- 完成受支持的 OAuth 流程并保存 access token、refresh token 或凭证文件
- 成功写入后通知来源对话

登录 token 的重要行为：

- 打开 `/link` 页面不会使用 token
- 启动 OAuth 不会使用 token
- 完成凭证 POST 或 OAuth callback 会使用 token
- 同一平台用户创建新的登录 token 时，旧登录 token 会失效

额外保护：

- 凭证 POST 路由要求 `Content-Type: application/json`。
- 设置 `LINK_URL` / `MIKAN_LINK_URL` 时，凭证 POST 路由会检查同源 `Origin` 或 `Referer`。
- OAuth state 独立于登录 token，有效期为 10 分钟，并使用 PKCE verifier。
- 机密值不会重新渲染到浏览器；现有 vault 摘要只显示机密名称和挂载目标。

### 会话视图

会话视图是会话内容访问权限，主要用于查看结构化会话时间线。

会话视图可以：

- 渲染会话时间线
- 浏览父/话题会话关系
- 通过 SSE 订阅实时状态和时间线更新
- 交互 wiring 可用时，从网页向所选会话发送消息

会话视图并非完全只读。只要存在 `/session/message` 路由且交互 wiring 可用，会话视图 token 就可以发送 `session_view` 事件并调用 bot handler。

会话视图 token 锚定到基础会话文件。使用 `/session?session=<file.jsonl>` 浏览时，只能切换到同一目录中的会话文件。

## 路由和 token 对照

| 路由                 | 方法   | Token 来源        | 验证                                     | 说明                                          |
| -------------------- | ------ | ----------------- | ---------------------------------------- | --------------------------------------------- |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                 | 渲染管理 portal。                             |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                 | 未授权时返回 403。                            |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                 | 未授权时返回 403。                            |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                  | 渲染登录/vault 页面；不使用 token。           |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`               | 写入凭证；使用 token。                        |
| `/api/oauth/start`   | `POST` | JSON body `token` | `linkTokenStore.peek()` + OAuth state    | 创建 OAuth redirect；此时尚不使用登录 token。 |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + `linkTokenStore.consume()` | 完成 OAuth；使用 OAuth state 和登录 token。   |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | 渲染会话页面。                                |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | 打开 SSE stream；需要交互 wiring。            |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`           | 发送会话消息；需要交互 wiring。               |

## 为什么不使用一种 token 类型

三种 token 对应不同的风险：

- 管理 token：可重复使用的短期管理权限。
- 登录 token：可以写入机密，因此有效期更短，并在写入时被使用。
- 会话视图 token：适合共享和审查会话，因此有效期更长，但权限仅限会话视图范围。

即使将来添加完整 dashboard，也应保留这些边界：

- Dashboard identity 可以授权查看和设置操作。
- 机密写入仍应要求短期的一次性 capability，或等效的二次确认。
- 独立会话链接仍可作为会话查看的 capability 链接。

## 实现位置

| 功能                | 主要代码                                                          |
| ------------------- | ----------------------------------------------------------------- |
| Portal HTTP 服务器  | `src/web/server.ts` 中的 `startWebServer()`                       |
| 管理 portal         | `src/web/admin/portal.ts`、`src/web/admin/store.ts`               |
| 登录 / vault portal | `src/web/login/portal.ts`、`src/web/login/store.ts`               |
| 会话视图            | `src/web/session-view/portal.ts`、`src/web/session-view/store.ts` |
| 共享 token store    | `src/web/token-store.ts`                                          |
| 共享 portal shell   | `src/web/portal-shell.ts`                                         |

`startWebServer()` 的分发顺序：

1. `GET /health`
2. Agent event HTTP routes
3. Admin routes
4. Session view routes
5. Login / vault routes
6. `404`

服务器仅在 `LINK_PORT` / `MIKAN_LINK_PORT` 可以解析为端口时启动。如果设置了 `LINK_URL` / `MIKAN_LINK_URL` 但未配置端口，mikan 使用默认端口 `8181`。

Token store 目前位于内存中，`src/main.ts` 每五分钟清理过期 token。进程重启会使所有未过期的 Web token 失效。

这些 URL 是 bearer capability。Query-string token 可能通过浏览器历史记录、截图、复制的 URL 或代理日志泄露；请只与预期用户共享，绝不要发布到聊天频道或 issue tracker 中。
