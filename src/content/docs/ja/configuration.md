---
title: 設定
description: 起動、グローバルおよび会話設定、プラットフォーム認証情報、sandbox 制限、環境変数を設定します。
---

## 初回セットアップ

通常起動する前に、mikan にはグローバル設定ファイルが必要です。一度作成して内容を確認し、workspace を指定して mikan を起動します：

```bash
mikan --onboard
mikan --sandbox=host /path/to/workspace
```

state directory の既定値は `~/.mikan` です。別の場所を選ぶ場合、onboarding と通常起動で同じ `--state-dir` を使用してください：

```bash
mikan --onboard --state-dir=/secure/mikan-state
mikan --state-dir=/secure/mikan-state /path/to/workspace
```

存在しない state directory は mode `0700` で作成されます。既存 directory は現在のユーザーが所有し、world-writable でないことが必要です。sandbox mode では、tools が認証情報や管理者設定へアクセスできないよう、workspace の外に置いてください。

## 設定の場所

| Scope        | Path                                                       | 用途                                   |
| ------------ | ---------------------------------------------------------- | -------------------------------------- |
| Global       | `<state-dir>/settings.json`                                | すべての conversation に必須の既定値   |
| Conversation | `<state-dir>/conversations/<conversationId>/settings.json` | 1 つの conversation 用の部分的な上書き |

Conversation settings は host-authoritative です。古い `<workspace>/<conversationId>/settings.json` files は初回アクセス時に移行され、それ以降 sandbox から見える workspace では読み込まれません。

## 生成される設定

`mikan --onboard` は次を作成します：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off",
    "autoReply": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5"
    }
  },
  "slack": {
    "replyMode": "top-level"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "1g",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    },
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  }
}
```

## 設定フィールド

以下の値は onboarding によって生成されます。解決後のグローバル設定では `llm.provider`、`llm.model`、`llm.thinkingLevel` が必須で、その他のフィールドは省略できます。

| フィールド                     | Onboarding の値     | 説明                                                                                                |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | メイン AI provider                                                                                  |
| `llm.model`                    | `claude-sonnet-4-6` | メイン model 名                                                                                     |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` のいずれか                                |
| `llm.autoReply.provider`       | `anthropic`         | auto-reply rules の評価に使う任意の model provider                                                  |
| `llm.autoReply.model`          | `claude-haiku-4-5`  | auto-reply rules の評価に使う任意の model                                                           |
| `sentry.dsn`                   | 未設定              | Sentry DSN。機密性の高い prompt と tool の内容はマスクされます                                      |
| `sandbox.cpus`                 | `0.5`               | mikan 管理の image containers の CPU 制限                                                           |
| `sandbox.memory`               | `1g`                | mikan 管理の image containers のメモリ制限                                                          |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` が適用する一時的な CPU 制限                                                     |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` が適用する一時的なメモリ制限                                                    |
| `sandbox.image.workspaceMount` | `private`           | `private` は共有 support files と現在の conversation を公開し、`full` は workspace 全体を公開します |
| `sandbox.defaultSharedVault`   | 空                  | 対象となる membership-trust image/Cloudflare conversations にコピーされる共有 vault                 |
| `slack.replyMode`              | `top-level`         | Slack 応答モード：`top-level` または `thread`                                                       |

`/pi-model` は conversation の部分的な上書きを書き込みます。`/pi-sandbox private|full` は conversation の workspace mount mode を更新します。Auto-reply の有効化と rule text は JSON settings fields ではなく、`/pi-auto-reply` と conversation の `auto-reply` marker file で管理されます。

## プラットフォーム認証情報

通常の bot mode には、少なくとも 1 組の完全な platform credentials が必要です：

| Platform | 必須の環境変数                                                                                                  | 任意の変数                             |
| -------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Slack    | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`                                                                            | —                                      |
| Telegram | `TELEGRAM_BOT_TOKEN`                                                                                            | —                                      |
| Discord  | `DISCORD_BOT_TOKEN`                                                                                             | —                                      |
| GitHub   | `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, および `GITHUB_APP_PRIVATE_KEY` または `GITHUB_APP_PRIVATE_KEY_PATH` | `GITHUB_REPOS`, `GITHUB_POLL_INTERVAL` |

プラットフォーム固有のセットアップと権限については [プラットフォーム接続](/ja/platform-adapters/) を参照してください。

## CLI リファレンス

| コマンドまたはオプション                                                                    | 用途                                                                |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `mikan --onboard [--state-dir=<dir>]`                                                       | 必須のグローバル設定ファイルを作成                                  |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] <workspace>`                                  | 設定済みの platform bots を起動                                     |
| `--sandbox=host \| container:<name> \| image:<image> \| firecracker:... \| cloudflare:<id>` | tool execution mode を選択。既定値は `host`                         |
| `mikan --download <channel-id>`                                                             | Slack channel history をダウンロード。`SLACK_BOT_TOKEN` が必要      |
| `mikan --version`                                                                           | インストール済み version を表示                                     |
| `mikan ext ...`                                                                             | harness extensions を管理。subcommands は `mikan ext --help` で確認 |

## 環境変数のエイリアス

mikan の設定 helper で読み込む環境変数は、`MIKAN_` prefix も受け付けます。たとえば `MIKAN_SLACK_APP_TOKEN` と `MIKAN_LINK_URL` は `SLACK_APP_TOKEN` と `LINK_URL` の fallback で、prefix なしの値が優先されます。`SENTRY_DSN` は例外です。直接設定するか、`settings.json` の `sentry.dsn` を設定してください。

mikan はログを stdout/stderr に書き込みます。PM2、systemd、Docker、または hosting platform を使って転送、保持してください。
