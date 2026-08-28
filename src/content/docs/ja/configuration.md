---
title: 設定
description: 起動、グローバルおよび会話設定、プラットフォーム認証情報、sandbox 制限、環境変数を設定します。
---

## 初回セットアップ

通常起動する前に、mikan にはグローバル設定ファイルが必要です。一度作成して内容を確認し、workspace を指定して mikan を起動します：

```bash
mikan onboard
mikan --sandbox=host /path/to/workspace
```

state directory の既定値は `~/.mikan` です。別の場所を選ぶ場合、onboarding と通常起動で同じ `--state-dir` を使用してください：

```bash
mikan onboard --state-dir=/secure/mikan-state
mikan --state-dir=/secure/mikan-state /path/to/workspace
```

存在しない state directory は mode `0700` で作成されます。既存 directory は現在のユーザーが所有し、world-writable でないことが必要です。sandbox mode では、tools が認証情報や管理者設定へアクセスできないよう、workspace の外に置いてください。

## 設定の場所

| Scope        | Path                                                  | 用途                                   |
| ------------ | ----------------------------------------------------- | -------------------------------------- |
| Global       | `<state-dir>/settings.json`                           | すべての conversation に必須の既定値   |
| Conversation | `<state-dir>/conversations/<officeKey>/settings.json` | 1 つの conversation 用の部分的な上書き |

Conversation settings は host-authoritative です。古い `<workspace>/<officeKey>/settings.json` files は初回アクセス時に移行され、それ以降 sandbox から見える workspace では読み込まれません。

### Office key

すべての conversation は _office_ であり、その platform とプラットフォームの生の conversation id の組で識別されます。ストレージの path は両者から導出した office key — `v1-<platform>-<readable-id>-<hash>`、たとえば `v1-slack-c0aaaaaa1-1f4b9c0d2e3a5b7c` — を使うため、生の conversation id がたまたま一致する 2 つのプラットフォームが互いの files・settings・認証情報を指すことは決してありません。同じ key が workspace 内の office directory、その state directory、その vault を指します。

Office key は生のプラットフォーム id へ逆変換できないため、host は `<state-dir>/office-registry.json` に registry を保持し、各 office の platform と conversation id を記録します。読み出しには `mikan office list` を使ってください。

conversation を生のプラットフォーム id 配下に保存していたリリースからアップグレードすると、それらの directory・vault・state tree は次回起動時に office key 配置へ移行されます。[デプロイ](/ja/deployment/#office-layout-migration-をまたぐアップグレード) を参照してください。

## 生成される設定

`mikan onboard` は次を作成します：

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
    "workspace": {
      "doorPolicy": "isolated"
    },
    "defaultSharedVault": ""
  }
}
```

## 設定フィールド

以下の値は onboarding によって生成されます。解決後のグローバル設定では `llm.provider`、`llm.model`、`llm.thinkingLevel` が必須で、その他のフィールドは省略できます。

| フィールド                     | Onboarding の値     | 説明                                                                                                                       |
| ------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | メイン AI provider                                                                                                         |
| `llm.model`                    | `claude-sonnet-4-6` | メイン model 名                                                                                                            |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` のいずれか                                                       |
| `llm.autoReply.provider`       | `anthropic`         | auto-reply rules の評価に使う任意の model provider                                                                         |
| `llm.autoReply.model`          | `claude-haiku-4-5`  | auto-reply rules の評価に使う任意の model                                                                                  |
| `sentry.dsn`                   | 未設定              | Sentry DSN。機密性の高い prompt と tool の内容はマスクされます                                                             |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` が適用する一時的な CPU 制限                                                                            |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` が適用する一時的なメモリ制限                                                                           |
| `sandbox.workspace.doorPolicy` | `isolated`          | `isolated` は各 conversation を自分の office data に限定します。`trusted` は協働型の workspace layout を明示的に許可します |
| `sandbox.workspace.layout`     | `conversation`      | 実効 layout：isolated は常に `conversation`、trusted は `shared-support` または `full`                                     |
| `sandbox.defaultSharedVault`   | 空                  | 対象となる membership-trust image/Cloudflare conversations にコピーされる共有 vault                                        |
| `slack.replyMode`              | `top-level`         | Slack 応答モード：`top-level` または `thread`                                                                              |

`/pi-model` は conversation の部分的な上書きを書き込み、`/pi-sandbox door <default|isolated|shared|full>` は conversation の `sandbox.workspace` 上書きを書き込みます。admin portal は office ごとの door policy とグローバルな door policy の両方を設定します。Auto-reply の有効化と rule text は JSON settings fields ではなく、`/pi-auto-reply` と conversation の `auto-reply` marker file で管理されます。

Door policy と layout は一緒に解決されます。`isolated` は常に `conversation` layout を意味し、office 自身の directory だけが mount されます。`trusted` は `shared-support` — office に加えて workspace レベルの `MEMORY.md`、`skills/`、`events/` — か、workspace root 全体を mount する `full` のどちらかです。layout 未指定の `trusted` は `shared-support` に解決されます。

旧来の `sandbox.image.workspaceMount` は移行のために引き続き読み取られます：`private` は `trusted` + `shared-support`、`full` は `trusted` + `full` を意味します。新規インストールは backend 非依存の正式な settings を書き込み、既定は `isolated` です。

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

| コマンドまたはオプション                                           | 用途                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `mikan onboard [--state-dir=<dir>]`                                | 必須のグローバル設定ファイルを作成                                                    |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] [working-directory]` | 設定済みの platform bots を起動。working directory の既定値は `<state-dir>/workspace` |
| `mikan env`                                                        | 環境変数の完全なインベントリと、現在設定されている内容を表示                          |
| `mikan --download <channel-id>`                                    | Slack channel history をダウンロード。`SLACK_BOT_TOKEN` が必要                        |
| `mikan --version`                                                  | インストール済み version を表示                                                       |
| `mikan --help`                                                     | CLI の使い方と platform-token のサマリーを表示                                        |
| `mikan ext ...`                                                    | harness extensions を管理。subcommands は `mikan ext` で確認                          |
| `mikan office list`                                                | 登録済み office、有効なプラットフォーム、保留中の legacy migration を一覧表示         |
| `mikan office claim <conversationId> <platform>`                   | boot が帰属を判定できなかった legacy な生 id directory の所有プラットフォームを指定   |

`mikan office` は `--state-dir <dir>` と `--workspace <dir>` を受け付けます。workspace の既定値は `<state-dir>/workspace` です。`claim` は判断を記録するだけで、実際の移動は daemon が次回起動時に行うため、daemon を停止した状態で実行してください。

## 環境変数のエイリアス

mikan の設定 helper で読み込む環境変数は、`MIKAN_` prefix も受け付けます。たとえば `MIKAN_SLACK_APP_TOKEN` と `MIKAN_LINK_URL` は `SLACK_APP_TOKEN` と `LINK_URL` の fallback で、prefix なしの値が優先されます。`SENTRY_DSN` は例外です。直接設定するか、`settings.json` の `sentry.dsn` を設定してください。

daemon の完全な環境インターフェースは、ソースツリー内の manifest として宣言されています。`mikan env` は、platform と feature ごとにグループ化された注釈付きインベントリを、各変数の現在の状態とともに表示するため、コードを読まずにデプロイを監査できます。

mikan はログを stdout/stderr に書き込みます。PM2、systemd、Docker、または hosting platform を使って転送、保持してください。
