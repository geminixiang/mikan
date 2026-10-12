---
title: Slack Bot 最小设置指南
description: 通过 Socket Mode 运行 mikan 所需的最小 Slack app 权限、事件和 manifest 设置。
---

## 让 mikan 创建并更新 app

mikan 可以替你创建 Slack app 并保持配置最新：新版本加了 slash command、scope 或 event 时，不必再到 Slack 设置页修改。这需要一个 Slack app configuration token：打开 [api.slack.com/apps](https://api.slack.com/apps)，在页面底部的 **Your App Configuration Tokens** 为你的 workspace 生成一个，复制其中的 **Refresh Token**（`xoxe-1-…`）。

- 新 app：运行 `mikan onboard`，选 Slack，再选 **Create a new Slack app for me**。mikan 会创建 app、打印安装链接，并请你粘贴 bot token 和 Socket Mode token；这两步 Slack 只在网页上提供。
- 已有 app：运行 `mikan slack token` 并粘贴 refresh token。mikan 下次启动时会用自己的 manifest 替换 app 配置；在 Slack 上手动添加的设置会被移除。
- 名称和描述：`mikan slack set --name <名称> --description <描述>` 会保存到 `~/.mikan/slack.json`，下次启动时应用。在 Slack 设置页的修改会被覆盖。

mikan 每次启动都会轮换 token，并把最新的一组保存在 `~/.mikan/slack-config-token.json`（0600）。每次轮换都会让上一组失效，所以一个 token 只给一个 mikan 使用。新版本加了 scope 时，mikan 会私信生成 token 的人重新安装的链接，在此之前 bot 以现有权限照常运行。token 属于生成它的人；此人离开 workspace 后，请改存另一位协作者的 token。mikan 应用的是下方的普通 app manifest，如果你的 app 是用 agent manifest 创建的，请不要保存 token。

你也可以使用 `deploy/examples/slack-app-manifest.json` 中的示例 manifest 创建 app。

## 1. 创建 Slack app

1. 打开 <https://api.slack.com/apps>。
2. 点击 **Create New App**。
3. 选择 **From scratch**。
4. 选择 app 名称（例如 `mikan`）和你的工作区。

## 2. 启用 Socket Mode

1. 前往 **Settings → Socket Mode**。
2. 打开 **Enable Socket Mode**。
3. 创建具有 `connections:write` scope 的 app-level token。
4. 将 token 存储为 `SLACK_APP_TOKEN`。

Token 以 `xapp-` 开头。

## 3. 配置 bot token scopes

前往 **OAuth & Permissions → Scopes → Bot Token Scopes** 并添加：

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `channels:read`
- `chat:write`
- `chat:write.customize`（子代理人设：没有这个 scope，Slack 会静默丢弃子代理最终回复的自定义用户名／图标，改用 bot 自己的身份发送——不会报错也不会警告，只是名字不对）
- `commands`（仅使用下方可选 slash commands 时需要）
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `reactions:write`
- `users:read`

然后将 app 安装或重新安装到工作区，并将 bot token 存储为 `SLACK_BOT_TOKEN`。

Token 以 `xoxb-` 开头。

## 4. 启用 App Home 和 Agent 模式

1. 前往 **Features → App Home**。
2. 启用 **Home Tab**。
3. 在 **Agents & AI Apps** 下启用 **Agent or Assistant**。

这会启用 Slack 的 assistant UI。mikan 通过 `assistant:write` 写入 assistant 工作状态；订阅的 assistant context 事件仅用于 Slack 兼容性，不会单独触发代理。

## 5. 订阅 bot events

前往 **Features → Event Subscriptions** 并启用 events。

订阅以下 bot events：

- `app_home_opened`
- `app_mention`
- `assistant_thread_context_changed`
- `assistant_thread_started`
- `message.channels`
- `message.groups`
- `message.im`

## 6. 启用 interactivity

前往 **Features → Interactivity & Shortcuts** 并启用 interactivity。

如果只使用 Socket Mode 进行本地开发，则不需要公开 request URL，但 Slack 在某些 app 设置中可能仍要求填写。

## 7. 可选的 slash commands

示例 manifest 包含常用控制 slash commands：

- `/pi-login` → 登录 portal
- `/pi-new` → 开始新的 DM 会话
- `/pi-compact` → 总结较早的消息以腾出上下文
- `/pi-session` → 会话查看器
- `/pi-model` → 切换此对话的 LLM（`provider/model[:thinking]`，例如 `anthropic/claude-sonnet-4-6:off`）
- `/pi-sandbox` → 检查或调整此对话的沙箱
- `/pi-admin` → 打开管理 portal

Slash commands 是可选的，因为文本命令也能在支持的上下文中使用。请将 `stop` 保留为文本命令（`stop` 或 `/stop`），以便话题本地的停止路由能够指向正确的会话。

## 8. 运行 mikan

mikan 需要先完成一次全局 settings 文件与 LLM provider key 的设置——`mikan onboard` 加上 `export ANTHROPIC_API_KEY=...`；参阅[快速开始](/zh-cn/quickstart/)——然后：

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan
```

mikan 的状态固定存放在 `~/.mikan`，working directory 默认为 `~/.mikan/workspace`；可用路径参数更改。`mikan --help` 列出所有标志，`mikan env` 显示当前已设置的变量。

Bot 会在 DM 中回复，也会在频道中被提及时回复。触发的 Slack 话题工作使用隔离会话，其 key 包含话题时间戳。共享频道话题中普通的未提及回复只会被记录，不会启动运行。

## 9. 选择沙箱

不带 `--sandbox` 时，mikan 会直接在主机上运行工具。办公室 visibility 跟随 Slack 对话类型：公开频道是 public 办公室，可写入共享的 `MEMORY.md` 和 `skills/`；私密频道和 DM 是 private 办公室，只能读取它们，且其他任何办公室都无法读取它们。Host 模式无法强制执行 private 办公室，会在运行它们时记录一次警告。请在第一次真正对话之前先选定一种：

- **推荐做法。** 使用受管理的沙箱，它为每个对话提供独立容器，无需更改设置即可强制执行办公室 visibility：

  ```bash
  mikan --sandbox=oci
  ```

- **Host 模式**，仅限在你已经信任其访问整个工作区的机器上：每个对话（包括 DM 和私密频道）都能读取其他所有对话的文件。

完整对比请参阅 [Sandbox](/zh-cn/sandbox/)。
