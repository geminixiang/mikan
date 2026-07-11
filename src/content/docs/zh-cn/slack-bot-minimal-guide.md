---
title: Slack Bot 最小设定指南
description: 透过 Socket Mode 执行 mikan 所需的最小 Slack app 权限、事件与 manifest 设定。
---

你也可以使用 `examples/slack-app-manifest.json` 的范例 manifest 建立 app。

## 1. 建立 Slack app

1. 开启 <https://api.slack.com/apps>。
2. 点选 **Create New App**。
3. 选择 **From scratch**。
4. 选择 app 名称，例如 `mikan`，并选取你的 workspace。

## 2. 启用 Socket Mode

1. 前往 **Settings → Socket Mode**。
2. 开启 **Enable Socket Mode**。
3. 建立具备 `connections:write` scope 的 app-level token。
4. 将 token 储存为 `SLACK_APP_TOKEN`。

Token 会以 `xapp-` 开头。

## 3. 设定 bot token scopes

前往 **OAuth & Permissions → Scopes → Bot Token Scopes**，加入：

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `reactions:write`
- `users:read`

接着将 app 安装或重新安装到你的 workspace，并把 bot token 储存为 `SLACK_BOT_TOKEN`。

Token 会以 `xoxb-` 开头。

## 4. 启用 App Home 与 Agent 模式

1. 前往 **Features → App Home**。
2. 启用 **Home Tab**。
3. 在 **Agents & AI Apps** 中启用 **Agent or Assistant**。

这会让 Slack 原生 assistant thread events 与 working indicators 传到 bot。

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

前往 **Features → Interactivity & Shortcuts** 并开启 interactivity。

若只使用 Socket Mode 进行本机开发，不需要公开 request URL；但某些 app 设定中 Slack 仍可能要求填写。

## 7. 可选的 slash commands

范例 manifest 包含常用控制用的 slash commands：

- `/pi-login` → login portal
- `/pi-new` → 开始新的 DM session
- `/pi-session` → session viewer
- `/pi-model` → 切换此 conversation 的 LLM（`provider/model[:thinking]`，例如 `anthropic/claude-sonnet-4-6:off`）
- `/pi-auto-reply` → 管理 group/channel auto-reply rules
- `/pi-sandbox` → 查看或调整此 conversation 的 sandbox
- `/pi-extensions` → 列出已安装的 extension
- `/pi-admin` → 打开管理后台

Slash commands 是可选的，因为文字指令在支援的情境中也可使用。请将 `stop` 保留为文字指令（`stop` 或 `/stop`），让 thread-local stop routing 能指向正确的 session。

## 8. 执行 mikan

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan --state-dir ~/.mikan /path/to/workspace
```

Bot 会在 DM 中回应，也会在 channel 中被 mention 时回应。Slack thread replies 会使用隔离的 thread sessions，并把 thread timestamp 作为 session key 的一部分。
