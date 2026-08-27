---
title: Slack Bot 最小セットアップガイド
description: Socket Mode で mikan を実行するために必要な最小限の Slack app 権限、イベント、manifest 設定。
---

`deploy/examples/slack-app-manifest.json` のサンプル manifest を使って app を作成することもできます。

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
- `commands`（以下の任意の slash commands を使う場合のみ必要）
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `reactions:write`
- `users:read`

次に app を workspace にインストールまたは再インストールし、bot token を `SLACK_BOT_TOKEN` として保存します。

Token は `xoxb-` で始まります。

## 4. App Home と Agent モードを有効化

1. **Features → App Home** に移動する。
2. **Home Tab** を有効化する。
3. **Agents & AI Apps** で **Agent or Assistant** を有効化する。

これにより Slack の assistant UI が有効になります。mikan は `assistant:write` を通じて assistant working status を書き込みます。購読する assistant context events は Slack 互換性のために予約されており、別の agent trigger ではありません。

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
- `/pi-sandbox` → この conversation の sandbox を確認・調整
- `/pi-extensions` → インストール済み extension を一覧
- `/pi-admin` → 管理ポータルを開く

Slash commands は任意です。対応する状況ではテキスト指令も使えるためです。`stop` は文字指令（`stop` または `/stop`）として残してください。これにより thread-local stop routing が正しい session を指せます。

## 8. mikan を実行

mikan は最初に一度、グローバル settings ファイルと LLM provider key のセットアップが必要です——`mikan onboard` と `export ANTHROPIC_API_KEY=...`。[クイックスタート](/ja/quickstart/)を参照してください。その後：

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan
```

state directory は既定で `~/.mikan`、working directory は既定で `<state-dir>/workspace` になります。`--state-dir=<dir>` またはパス引数で変更できます。`mikan --help` はすべてのフラグを、`mikan env` は現在設定されている変数を表示します。

Bot は DM で応答し、channel では mention されたときに応答します。起動された Slack thread の作業は、thread timestamp を key に含む隔離された session を使います。共有 channel の thread にある通常の mention なしの reply は記録されますが、実行を開始しません。

## 9. sandbox を選ぶ

`--sandbox` を指定しない場合、mikan は tools を host 上で直接実行しますが、既定の `isolated` door
policy はその組み合わせを設計上拒否します。最初のメッセージで、`host` は隔離された conversation
office を提供できないと報告されます。最初の実運用の会話を始める前に、どちらかを選んでください：

- **推奨。** 管理型 sandbox を使います。conversation ごとに専用の container が与えられ、設定を変更
  せずに isolated policy を満たします：

  ```bash
  mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest
  ```

- **Host mode** は、workspace 全体を任せられる、すでに信頼しているマシンでのみ使用してください。
  `~/.mikan/settings.json` に trusted な door policy を追加します。

  ```json
  {
    "sandbox": {
      "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
    }
  }
  ```

完全な比較は [Sandbox](/ja/sandbox/) を参照してください。
