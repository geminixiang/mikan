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
- `commands`（只有使用下方選用的 slash commands 時才需要）
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `reactions:write`
- `users:read`

接著將 app 安裝或重新安裝到你的 workspace，並把 bot token 儲存為 `SLACK_BOT_TOKEN`。

Token 會以 `xoxb-` 開頭。

## 4. 啟用 App Home 與 Agent 模式

1. 前往 **Features → App Home**。
2. 啟用 **Home Tab**。
3. 在 **Agents & AI Apps** 中啟用 **Agent or Assistant**。

這會啟用 Slack assistant UI。mikan 會透過 `assistant:write` 寫入 assistant working status；訂閱的 assistant context events 是為了與 Slack 相容而保留，並非獨立的 agent triggers。

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
- `/pi-sandbox` → 查看或調整此 conversation 的 sandbox
- `/pi-extensions` → 列出已安裝的 extension
- `/pi-admin` → 開啟管理後台

Slash commands 是可選的，因為文字指令在支援的情境中也可使用。請將 `stop` 保留為文字指令（`stop` 或 `/stop`），讓 thread-local stop routing 能指向正確的 session。

## 8. 執行 mikan

mikan 需要先完成一次全域 settings 檔與 LLM provider key 的設定——`mikan --onboard` 加上 `export ANTHROPIC_API_KEY=...`；請參閱[快速開始](/zh-tw/quickstart/)——然後：

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan
```

state directory 預設為 `~/.mikan`，working directory 預設為 `<state-dir>/workspace`；可用 `--state-dir=<dir>` 或路徑引數改變。`mikan --help` 列出所有旗標，`mikan env` 顯示目前已設定的變數。

Bot 會在 DM 中回應，也會在 channel 中被 mention 時回應。觸發的 Slack thread 工作會使用隔離的 session，其 key 包含 thread timestamp。共享頻道 thread 中未 mention 的一般回覆會被記錄，但不會開始執行。
