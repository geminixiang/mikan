---
title: Slack Bot 最小設定指南
description: 透過 Socket Mode 執行 mikan 所需的最小 Slack app 權限、事件與 manifest 設定。
---

你也可以使用 `examples/slack-app-manifest.json` 的範例 manifest 建立 app。

## 1. 建立 Slack app

1. 開啟 <https://api.slack.com/apps>。
2. 點選 **Create New App**。
3. 選擇 **From scratch**。
4. 選擇 app 名稱，例如 `mikan`，並選取你的 workspace。

## 2. 啟用 Socket Mode

1. 前往 **Settings → Socket Mode**。
2. 開啟 **Enable Socket Mode**。
3. 建立具備 `connections:write` scope 的 app-level token。
4. 將 token 儲存為 `SLACK_APP_TOKEN`。

Token 會以 `xapp-` 開頭。

## 3. 設定 bot token scopes

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
- `users:read`

接著將 app 安裝或重新安裝到你的 workspace，並把 bot token 儲存為 `SLACK_BOT_TOKEN`。

Token 會以 `xoxb-` 開頭。

## 4. 啟用 App Home 與 Agent 模式

1. 前往 **Features → App Home**。
2. 啟用 **Home Tab**。
3. 在 **Agents & AI Apps** 中啟用 **Agent or Assistant**。

這會讓 Slack 原生 assistant thread events 與 working indicators 傳到 bot。

## 5. 訂閱 bot events

前往 **Features → Event Subscriptions** 並啟用 events。

訂閱以下 bot events：

- `app_home_opened`
- `app_mention`
- `assistant_thread_context_changed`
- `assistant_thread_started`
- `message.channels`
- `message.groups`
- `message.im`

## 6. 啟用 interactivity

前往 **Features → Interactivity & Shortcuts** 並開啟 interactivity。

若只使用 Socket Mode 進行本機開發，不需要公開 request URL；但某些 app 設定中 Slack 仍可能要求填寫。

## 7. 可選的 slash commands

範例 manifest 包含常用控制用的 slash commands：

- `/pi-login` → login portal
- `/pi-new` → 開始新的 DM session
- `/pi-session` → session viewer
- `/pi-model` → 切換此 conversation 的 LLM（`provider/model[:thinking]`，例如 `anthropic/claude-sonnet-4-6:off`）
- `/pi-auto-reply` → 管理 group/channel auto-reply rules

Slash commands 是可選的，因為文字指令在支援的情境中也可使用。請將 `stop` 保留為文字指令（`stop` 或 `/stop`），讓 thread-local stop routing 能指向正確的 session。

## 8. 執行 mikan

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan --state-dir ~/.mikan /path/to/workspace
```

Bot 會在 DM 中回應，也會在 channel 中被 mention 時回應。Slack thread replies 會使用隔離的 thread sessions，並把 thread timestamp 作為 session key 的一部分。
