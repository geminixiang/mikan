---
title: 設定
description: グローバルおよび会話レベルのモデル、sandbox、Slack 返信モード、auto-reply、vault の既定値を設定します。
---

各会話の設定は `<working-directory>/<conversationId>/settings.json` にあり、その会話ではグローバル設定を上書きします。

## 例

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  },
  "sentry": {
    "dsn": "https://examplePublicKey@o0.ingest.sentry.io/0"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    },
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  },
  "slack": {
    "replyMode": "top-level"
  }
}
```

## フィールド

| フィールド                     | 既定値              | 説明                                                                                                  |
| ------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | AI プロバイダー                                                                                       |
| `llm.model`                    | `claude-sonnet-4-6` | モデル名                                                                                              |
| `llm.thinkingLevel`            | `off`               | `off` / `low` / `medium` / `high`                                                                     |
| `sentry.dsn`                   | 未設定              | Sentry DSN。機密性の高い prompt / tool 内容はマスクされます                                           |
| `sandbox.cpus`                 | 未設定              | 管理対象 container の CPU 制限                                                                        |
| `sandbox.memory`               | 未設定              | 管理対象 container のメモリ制限                                                                       |
| `sandbox.boost.cpus`           | 未設定              | `/pi-sandbox boost` が使う一時的な CPU 制限                                                           |
| `sandbox.boost.memory`         | 未設定              | `/pi-sandbox boost` が使う一時的なメモリ制限                                                          |
| `sandbox.image.workspaceMount` | `private`           | `private` は会話 workspace のみをマウントします。`full` は workspace ディレクトリ全体をマウントします |
| `sandbox.defaultSharedVault`   | 未設定              | 独自の保管庫を持たない会話に使う既定の共有保管庫キー                                                  |
| `slack.replyMode`              | `top-level`         | Slack 応答モード: `top-level` または `thread`                                                         |

`/pi-sandbox` は現在の管理対象 container の CPU / メモリ制限を表示します。`/pi-sandbox boost` は `sandbox.boost` を現在の会話へ一時的に適用します。その sandbox container が停止すると、boost も終了します。

会話ローカル設定は同じ構造を使い、その会話のグローバル設定を上書きします。`/pi-model` が書き込む設定は通常、モデル上書きのみを含みます:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  }
}
```

各環境変数は、デプロイ専用の名前空間として `MIKAN_` プレフィックスもサポートします。たとえば `MIKAN_SLACK_APP_TOKEN` と `MIKAN_LINK_URL` はどちらも fallback として受け付けられます。プレフィックスなしの変数が優先されます。

mikan はログを stdout/stderr に書き込みます。プロセスマネージャーまたはホストプラットフォーム（PM2、systemd、Docker、クラウドログエージェントなど）を使って、好みのバックエンドへログを転送してください。
