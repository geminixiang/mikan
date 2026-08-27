---
title: Slack Bot 最小设置指南
description: 通过 Socket Mode 运行 mikan 所需的最小 Slack app 权限、事件和 manifest 设置。
---

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
- `/pi-session` → 会话查看器
- `/pi-model` → 切换此对话的 LLM（`provider/model[:thinking]`，例如 `anthropic/claude-sonnet-4-6:off`）
- `/pi-auto-reply` → 管理群组/频道自动回复规则
- `/pi-sandbox` → 检查或调整此对话的沙箱
- `/pi-extensions` → 列出已安装的扩展
- `/pi-admin` → 打开管理 portal

Slash commands 是可选的，因为文本命令也能在支持的上下文中使用。请将 `stop` 保留为文本命令（`stop` 或 `/stop`），以便话题本地的停止路由能够指向正确的会话。

## 8. 运行 mikan

mikan 需要先完成一次全局 settings 文件与 LLM provider key 的设置——`mikan onboard` 加上 `export ANTHROPIC_API_KEY=...`；参阅[快速开始](/zh-cn/quickstart/)——然后：

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan
```

state directory 默认为 `~/.mikan`，working directory 默认为 `<state-dir>/workspace`；可用 `--state-dir=<dir>` 或路径参数更改。`mikan --help` 列出所有标志，`mikan env` 显示当前已设置的变量。

Bot 会在 DM 中回复，也会在频道中被提及时回复。触发的 Slack 话题工作使用隔离会话，其 key 包含话题时间戳。共享频道话题中普通的未提及回复只会被记录，不会启动运行。

## 9. 选择沙箱

不带 `--sandbox` 时，mikan 会直接在主机上运行工具，而默认的 `isolated` 门禁策略按设计会拒绝这一组合——
第一条消息就会报告 `host` 无法提供隔离的对话办公室。请在第一次真正对话之前先选定一种：

- **推荐做法。** 使用受管理的沙箱，它为每个对话提供独立容器，无需更改任何设置即可满足 isolated 策略：

  ```bash
  mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest
  ```

- **Host 模式**，仅限在你已经信任其访问整个工作区的机器上：在 `~/.mikan/settings.json` 中加入受信任的门禁策略。

  ```json
  {
    "sandbox": {
      "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
    }
  }
  ```

完整对比请参阅 [Sandbox](/zh-cn/sandbox/)。
