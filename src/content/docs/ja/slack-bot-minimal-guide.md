---
title: Slack Bot 最小セットアップガイド
description: Socket Mode で mikan を実行するために必要な最小限の Slack app 権限、イベント、manifest 設定。
---

`examples/slack-app-manifest.json` のサンプル manifest を使って app を作成することもできます。

## 1. Slack app を作成

1. <https://api.slack.com/apps> を開く。
2. **Create New App** をクリックする。
3. **From scratch** を選ぶ。
4. `mikan` などの app 名を選び、workspace を選択する。

## 2. Socket Mode を有効化

1. **Settings → Socket Mode** に移動する。
2. **Enable Socket Mode** をオンにする。
3. `connections:write` scope を持つ app-level token を作成する。
4. token を `SLACK_APP_TOKEN` として保存する。

Token は `xapp-` で始まります。

## 3. bot token scopes を設定

**OAuth & Permissions → Scopes → Bot Token Scopes** に移動し、次を追加します。

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

次に app を workspace にインストールまたは再インストールし、bot token を `SLACK_BOT_TOKEN` として保存します。

Token は `xoxb-` で始まります。

## 4. App Home と Agent モードを有効化

1. **Features → App Home** に移動する。
2. **Home Tab** を有効化する。
3. **Agents & AI Apps** で **Agent or Assistant** を有効化する。

これにより Slack ネイティブの assistant thread events と working indicators が bot に届きます。

## 5. bot events を購読

**Features → Event Subscriptions** に移動し、events を有効化します。

次の bot events を購読します。

- `app_home_opened`
- `app_mention`
- `assistant_thread_context_changed`
- `assistant_thread_started`
- `message.channels`
- `message.groups`
- `message.im`

## 6. interactivity を有効化

**Features → Interactivity & Shortcuts** に移動し、interactivity をオンにします。

Socket Mode だけでローカル開発する場合、公開 request URL は不要です。ただし一部の app 設定では Slack が入力を求めることがあります。

## 7. 任意の slash commands

サンプル manifest には、よく使う制御用 slash commands が含まれています。

- `/pi-login` → login portal
- `/pi-new` → 新しい DM session を開始
- `/pi-session` → session viewer
- `/pi-model` → この conversation の LLM を切り替え（`provider/model[:thinking]`、例：`anthropic/claude-sonnet-4-6:off`）
- `/pi-auto-reply` → group/channel auto-reply rules を管理

Slash commands は任意です。対応する状況ではテキスト指令も使えるためです。`stop` は文字指令（`stop` または `/stop`）として残してください。これにより thread-local stop routing が正しい session を指せます。

## 8. mikan を実行

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan --state-dir ~/.mikan /path/to/workspace
```

Bot は DM で応答し、channel では mention されたときに応答します。Slack thread replies は隔離された thread sessions を使い、thread timestamp を session key の一部にします。
