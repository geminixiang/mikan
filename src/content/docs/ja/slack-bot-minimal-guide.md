---
title: Slack Bot 最小セットアップガイド
description: Socket Mode で mikan を実行するために必要な最小限の Slack app 権限、イベント、manifest 設定。
---

## mikan に app の作成と更新を任せる

mikan は Slack app を作成し、設定を最新に保てます。新しいリリースで slash command、scope、event が増えても、Slack の設定ページを編集する必要はありません。必要なのは Slack app configuration token です。[api.slack.com/apps](https://api.slack.com/apps) を開き、ページ下部の **Your App Configuration Tokens** でワークスペース用に生成し、**Refresh Token**（`xoxe-1-…`）をコピーします。

- 新しい app：`mikan onboard` を実行し、Slack を選んでから **Create a new Slack app for me** を選びます。mikan が app を作成してインストールリンクを表示し、bot token と Socket Mode token を尋ねます。この 2 つの手順は Slack の Web ページでしか行えません。
- 既存の app：`mikan slack token` を実行して refresh token を貼り付けます。次回の起動時に mikan が自身の manifest で app の設定を置き換えます。Slack 上で手動で追加した設定は削除されます。
- 名前と説明：`mikan slack set --name <名前> --description <説明>` で `~/.mikan/slack.json` に保存され、次回の起動時に適用されます。名前は app 名と会話での bot の表示名の両方になります。Slack の bot 名は英字、数字、スペース、`.`、`_`、`-` しか使えないため、それ以外の名前（日本語など）では bot は `mikan` のままです。Slack の設定ページでの変更は上書きされます。

mikan は起動のたびに token をローテーションし、最新のものを `~/.mikan/slack-config-token.json`（0600）に保存します。ローテーションすると以前の token は無効になるため、1 つの token は 1 つの mikan だけで使ってください。リリースで scope が増えると、mikan は token を作成した人に再インストールのリンクを DM で送り、それまで bot は今の権限のまま動き続けます。token は作成した人に属するため、その人がワークスペースを離れたら別のコラボレーターの token を保存してください。mikan が適用するのは下記の通常の app manifest なので、agent manifest で作った app には token を保存しないでください。

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
- `chat:write.customize`（サブエージェント廃止後は未使用。インストール済みアプリの scope を変えないよう、mikan の manifest には残しています）
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

## 4. Agent モードを有効化

1. **Agents & AI Apps** で **Agent or Assistant** を有効化する。

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
- `/pi-compact` → 古いメッセージを要約して context を空ける
- `/pi-session` → session viewer
- `/pi-model` → この conversation の LLM を切り替え（`provider/model[:thinking]`、例：`anthropic/claude-sonnet-4-6:off`）
- `/pi-sandbox` → この conversation の sandbox を確認・調整
- `/pi-admin` → 管理ポータルを開く

Slash commands は任意です。対応する状況ではテキスト指令も使えるためです。`stop` は文字指令（`stop` または `/stop`）として残してください。これにより thread-local stop routing が正しい session を指せます。

## 8. mikan を実行

mikan は最初に一度、グローバル settings ファイルと LLM provider key のセットアップが必要です——`mikan onboard` と `export ANTHROPIC_API_KEY=...`。[クイックスタート](/ja/quickstart/)を参照してください。その後：

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan
```

mikan の state は常に `~/.mikan` に置かれ、working directory は既定で `~/.mikan/workspace` になります。パス引数で変更できます。`mikan --help` はすべてのフラグを、`mikan env` は現在設定されている変数を表示します。

Bot は DM で応答し、channel では mention されたときに応答します。起動された Slack thread の作業は、thread timestamp を key に含む隔離された session を使います。共有 channel の thread にある通常の mention なしの reply は記録されますが、実行を開始しません。

## 9. sandbox を選ぶ

`--sandbox` を指定しない場合、mikan は tools を host 上で直接実行します。Office visibility は
Slack の conversation type に従います。public channel は共有の `MEMORY.md` と `skills/` に書き込める
public office であり、private channel と DM はそれらを読むだけで、他のどの office からも読まれない private
office です。Host mode は private office を強制できず、一度だけ警告を記録してそのまま実行します。最初の実運用の会話を始める前に、どちらかを選んでください：

- **推奨。** 管理型 sandbox を使います。conversation ごとに専用の container が与えられ、設定を変更
  せずに office visibility を強制できます：

  ```bash
  mikan --sandbox=oci
  ```

- **Host mode** は、workspace 全体を任せられる、すでに信頼しているマシンでのみ使用してください。
  DM や private channel を含むすべての conversation が、他のすべての conversation の files を読めます。

完全な比較は [Sandbox](/ja/sandbox/) を参照してください。
