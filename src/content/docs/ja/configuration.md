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
    "thinkingLevel": "off"
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
    }
  }
}
```

## 設定フィールド

以下の値は onboarding によって生成されます。解決後のグローバル設定では `llm.provider`、`llm.model`、`llm.thinkingLevel` が必須で、その他のフィールドは省略できます。

| フィールド             | Onboarding の値     | 説明                                                                                                              |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `llm.provider`         | `anthropic`         | メイン AI provider                                                                                                |
| `llm.model`            | `claude-sonnet-4-6` | メイン model 名                                                                                                   |
| `llm.thinkingLevel`    | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` のいずれか                                              |
| `sentry.dsn`           | 未設定              | Sentry DSN。機密性の高い prompt と tool の内容はマスクされます                                                    |
| `sandbox.boost.cpus`   | `2`                 | `/pi-sandbox boost` が適用する一時的な CPU 制限                                                                   |
| `sandbox.boost.memory` | `4g`                | `/pi-sandbox boost` が適用する一時的なメモリ制限                                                                  |
| `office.visibility`    | 未設定              | conversation 限定の上書き。`private` は Slack public channel を private office に狭めます。広げることはできません |
| `slack.replyMode`      | `top-level`         | Slack 応答モード：`top-level` または `thread`                                                                     |

`/pi-model` は conversation の部分的な上書きを書き込み、`/pi-sandbox visibility <private|default>` は conversation の `office.visibility` の上書きを書き込みます。admin portal にも同じスイッチがあります。

Slack auto-reply は `/pi-auto-reply on|off` で変更し、conversation office の `auto-reply`（on）または `auto-reply.disabled`（off）marker file に保存します。Marker の内容は無視されます。有効な channel では mikan 宛てでない top-level human message も rules や judge model なしで実行を開始します。Top-level `autoReply` と `llm.autoReply` JSON 設定は引き続き廃止済みとして無視されます。

Office visibility は Slack の conversation type に従います（ADR 0008）。Telegram、Discord、GitHub の conversation は常に private です。public channel は **public** office です。他のすべての office が `/workspace/public/<office key>` で読み取り専用に参照でき、workspace 全体の `MEMORY.md` と `skills/` に書き込めます。private channel、DM、group DM、外部共有 channel、および種別が未観測の conversation は **private** office です。自分自身にだけ見え、共有知識と public office を読めますが書き戻しません。すべての office は同じ mount 形状を持ち、workspace root を mount する layout はありません。

visibility を強制できるのは `image:*` だけです。`host`、`container:*`、`cloudflare:*` はすべての office を一つの filesystem で動かす trusted deployment であり、そこでの private office は一度だけ警告を記録して通常どおり動作します。

廃止された door policy 設定（`sandbox.workspace.doorPolicy`、`layout`、`visibility`、および legacy の `sandbox.image.workspaceMount`）は古いファイルを読み込むために引き続き解析されますが、解決後の設定からは取り除かれ、projection には一切影響しません。daemon を停止して `mikan office migrate-door-policy` を実行すると、global と各 office の settings ファイルからこれらの key が削除され、明示的な shared-support `private` visibility だけが `office.visibility` に引き継がれます。それ以外は何も導出されません。他の private office へのアクセスには ADR 0008 のメンバーシップに基づく権限付与が必要で、より広い mount では実現しません。

## MCP servers

`mcpServers` は stdio または Streamable HTTP MCP server に接続し、tool を `mcp__<server>__<tool>` として公開します。MCP server は host 側で実行または接続され、`env`／`headers` の credential は model や sandbox に公開されません。

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "package@fixed-version"],
      "env": { "API_TOKEN": "..." }
    },
    "internal-docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

各 entry は 1 種類の transport だけを使用します。`command` は `args`／`env`、`url` は `headers` と組み合わせられます。`disabled: true` は entry を削除せずに server を無効化します。global と conversation の設定は server name 単位で merge され、conversation 設定は同名の global server を上書きまたは無効化し、他の global entries はそのまま残ります。

Admin の MCP panel には repository-owned の curated Marketplace があります。install 前に完全な host command または remote endpoint、必要な credentials、source、target scope、security warning を表示し、確認後は通常の `mcpServers` entry だけを書き込みます。Local package version は pin され、別の installed database や automatic updater は作りません。また、catalog 掲載は security certification ではありません。Local stdio preset は mikan host 上で code を実行し、remote preset はその tool に送られた call と data を受信します。

OpenConnector は deployment default を持つ通常の MCP server です。`OPENCONNECTOR_ENDPOINT` が default の `open-connector` server を指定し、`OPENCONNECTOR_ADMIN_TOKEN` は conversation ごとの runtime token を発行する host-only の credential です。Slack conversation が global または conversation 設定で `open-connector` を宣言していない場合、mikan は `mikan:slack:<workspace-id>:<channel-id>` という名前の token を作成し（現在の OpenConnector deployment の action／proxy policy をコピー）、その conversation の host-only settings に通常の `mcpServers` entry として保存します。以降この entry は Admin MCP パネルに表示され、他の server と同様にテスト、無効化、削除、または self-hosted OpenConnector への置き換えができます。削除すると次の応答で default が再作成され、無効化すると統合が停止します。Admin token は default endpoint の origin にのみ送信され、settings や sandbox には入りません。既存の `open-connector-runtime-token.json` は daemon 停止後に `mikan office migrate-openconnector` で変換できます。

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
| `mikan office list`                                                | 登録済み office、有効なプラットフォーム、保留中の legacy migration を一覧表示         |
| `mikan office claim <conversationId> <platform>`                   | boot が帰属を判定できなかった legacy な生 id directory の所有プラットフォームを指定   |

`mikan office` は `--state-dir <dir>` と `--workspace <dir>` を受け付けます。workspace の既定値は `<state-dir>/workspace` です。`claim` は判断を記録するだけで、実際の移動は daemon が次回起動時に行うため、daemon を停止した状態で実行してください。

## Observability：OTLP、Sentry、Phoenix

mikan は単一の OpenTelemetry traces/metrics pipeline を所有し、標準 OTLP HTTP/protobuf で export します。明示的な OTLP endpoint があり、`OTEL_SDK_DISABLED` が `true` でない場合のみ有効です。ゼロ設定では no-op のままです。Collector には `OTEL_EXPORTER_OTLP_ENDPOINT`、signal ごとには `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` と `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` を使います。base endpoint には `/v1/traces` と `/v1/metrics` が追加され、per-signal endpoint には完全な path が必要です。認証は URL ではなく対応する `*_HEADERS` に置いてください。

ローカルの [Arize Phoenix](https://github.com/Arize-ai/phoenix) には `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces` を設定します。Phoenix は traces を受信しますが OTLP metrics ingestion は提供しません。metrics は Collector または別 backend に送ってください。mikan は同じ spans に content-free な標準 GenAI attributes と最小 OpenInference projection を付け、provider、model、token counts、duration、status、session attribution、tool name を duplicate spans なしで保持します。

`SENTRY_DSN`（または互換の `sentry.dsn`）は Sentry issue reporting を有効にし、error を active OpenTelemetry trace に link します。Sentry が第2の application trace/metric pipeline を作ることはありません。同じ traces を Phoenix と Sentry の両方へ送る場合は OpenTelemetry Collector で fan-out してください。Sentry direct OTLP は現在 traces/logs をサポートしますが OTLP metrics はサポートしません。

サポート protocol は `http/protobuf` のみです。`OTEL_TRACES_EXPORTER=none` と `OTEL_METRICS_EXPORTER=none` で signal ごとに無効化できます。prompts、completions、message text、tool arguments/results、file contents、credentials、tokens、absolute paths は送信しません。一方で model ID、token/cost totals、timings、payload sizes、tool categories、retry/compaction/budget counts など、content-free な運用 metadata は送信します。platform conversation、session、message、thread、user identifiers は trace を送信元へ直接対応付けられるよう raw operational ID として export します。human-readable username、channel name、workspace name は引き続き送信しません。resource attributes は allowlist されるため、`OTEL_RESOURCE_ATTRIBUTES` に secrets や paths を入れないでください。shutdown は conversation work を drain した後に OTLP を flush/shutdown し、最後に Sentry を close します。

## 環境変数のエイリアス

mikan の設定 helper で読み込む環境変数は、`MIKAN_` prefix も受け付けます。たとえば `MIKAN_SLACK_APP_TOKEN` と `MIKAN_LINK_URL` は `SLACK_APP_TOKEN` と `LINK_URL` の fallback で、prefix なしの値が優先されます。`SENTRY_DSN` は例外です。直接設定するか、`settings.json` の `sentry.dsn` を設定してください。

daemon の完全な環境インターフェースは、ソースツリー内の manifest として宣言されています。`mikan env` は、platform と feature ごとにグループ化された注釈付きインベントリを、各変数の現在の状態とともに表示するため、コードを読まずにデプロイを監査できます。

mikan はログを stdout/stderr に書き込みます。PM2、systemd、Docker、または hosting platform を使って転送、保持してください。
