---
title: 拡張機能の開発とインストール
description: ホスト側の mikan 拡張機能を安全に構築、検証、インストール、更新、運用します。
---

import { Steps } from "@astrojs/starlight/components";

mikan 拡張機能を使うと、mikan 自体を変更せずに、フック、エージェントツール、スケジュール、プロアクティブメッセージ、リアクション、シークレット、同梱スキルを追加できます。拡張機能は[スキル](skills/)とは異なります。スキルはプロンプトの内容ですが、拡張機能は mikan ホストプロセスに読み込まれる実行可能コードです。

:::caution[拡張機能は信頼されたホストコードです]
拡張機能は mikan と同じオペレーティングシステム権限で実行され、ホストのファイル、プラットフォームトークン、ネットワークリソースにアクセスできます。レビュー済みのコードのみをインストールしてください。拡張機能のコードはホスト専用の状態ディレクトリ内に配置し、サンドボックスにマウントされたワークスペースには決して配置しないでください。
:::

## クイックスタート

<Steps>

1. **最小限の拡張機能を作成する**

   mikan ワークスペースの外にディレクトリを作成します。

   ```text
   hello-mikan/
   ├── index.ts
   └── package.json
   ```

   TypeScript の型を利用するため、mikan を開発依存関係として使用します。

   ```json
   {
     "name": "hello-mikan",
     "version": "0.1.0",
     "private": true,
     "type": "module",
     "devDependencies": {
       "@geminixiang/mikan": "*"
     },
     "mikan": {
       "extensions": ["./index.ts"]
     }
   }
   ```

   ライフサイクルスクリプトを実行せずに開発依存関係をインストールします。

   ```bash
   cd hello-mikan
   npm install --ignore-scripts
   ```

   `index.ts` を追加します。

   ```ts
   import type { MikanExtensionApi } from "@geminixiang/mikan";

   export default function activate(api: MikanExtensionApi): void {
     api.log(`hello-mikan active for ${api.context.conversationId}`);

     api.on("before_agent_start", (event) => ({
       systemPrompt: `${event.systemPrompt}\n\nAlways end the final answer with: 🍊`,
     }));
   }
   ```

   `activate(api)` は会話ハーネスのインスタンスごとに一度呼び出されます。TypeScript、MTS、ESM JavaScript、MJS のエントリポイントは jiti を介して直接読み込まれるため、ビルド手順は不要です。

1. **有効化せずに検証する**

   ```bash
   mikan ext validate ./hello-mikan
   ```

   検証では、エントリポイントを解決してモジュールをインポートし、デフォルトまたは名前付きの `activate` 関数がエクスポートされていることを確認します。インポートによりトップレベルのモジュールコードは実行されますが、`activate` は呼び出されません。トップレベルのコードには副作用を持たせないでください。

   使用可能なレイアウト：

   ```text
   extensions/audit.mjs
   extensions/audit/index.ts
   extensions/audit/package.json  # mikan.extensions points to the entrypoint
   ```

   ディレクトリエントリポイントのフォールバック名は `index.mjs`、`index.js`、`index.ts`、`index.mts` です。名前、バージョン、説明、エントリポイント、依存関係の情報源としては `package.json` が優先されます。

1. **インストールして有効化する**

   スコープを正確に一つ選択します。

   ```bash
   # One conversation: safer default for conversation-specific behavior
   mikan ext install ./hello-mikan --conversation <conversationId>

   # Every conversation
   mikan ext install ./hello-mikan --global
   ```

   実行中の mikan インスタンスの状態ディレクトリが `~/.mikan` でない場合は、それと同じ状態ディレクトリを使用します。

   ```bash
   mikan ext install ./hello-mikan \
     --conversation <conversationId> \
     --state-dir=/srv/mikan/state
   ```

   インストール後、影響を受ける各会話で `/pi-new` を送信します。新しいハーネスインスタンスが拡張機能を検出して有効化するため、mikan プロセス全体を再起動する必要はありません。

   インストール先：

   | スコープ   | コードパス                                                      | デフォルトのデータパス                                              |
   | ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
   | グローバル | `<state-dir>/global/extensions/<slug>/`                         | `<state-dir>/conversations/<conversationId>/extension-data/<slug>/` |
   | 会話       | `<state-dir>/conversations/<conversationId>/extensions/<slug>/` | `<state-dir>/conversations/<conversationId>/extension-data/<slug>/` |

   グローバルインストールは、コードを利用できる場所を制御します。グローバル拡張機能であっても、`api.paths.dataDir` は会話ごとに分離されたままです。

</Steps>

## 4. Git からインストールする

サポートされるソースには、HTTPS Git URL、SSH Git URL、GitHub の短縮表記があります。拡張機能が大きなリポジトリ内にある場合は、`#subpath` を付加します。

```bash
mikan ext install \
  github:geminixiang/mikan#examples/extensions/agent-pm \
  --conversation <conversationId>
```

`mikan ext install` はコードを検証してコピーしますが、`npm install` は実行しません。Node の組み込み機能を優先し、ランタイム依存関係をゼロにしてください。ランタイムパッケージが必要な場合は、ローカルインストールの前にレビュー済みのローカル拡張機能ディレクトリへインストールし、コピーされた拡張機能に必要な `node_modules` が含まれていることを確認してください。

## 5. 拡張機能 API

### フック

```ts
api.on("tool_call", ({ toolName, args }) => {
  if (toolName === "bash" && JSON.stringify(args).includes("rm -rf")) {
    return { block: true, reason: "Blocked by extension policy" };
  }
});
```

| フック               | 用途                                             |
| -------------------- | ------------------------------------------------ |
| `before_agent_start` | ターンのシステムプロンプトを置換、または追記する |
| `tool_call`          | 実行前にツール呼び出しを監視、またはブロックする |
| `tool_result`        | ツールの出力を監視する                           |
| `message_end`        | 完了した一つのエージェントメッセージを監視する   |
| `turn_end`           | 完了したターンを監視する                         |
| `session_compact`    | セッションのコンパクションとその理由を監視する   |

フックは登録順に実行されます。結果を返すフックでは、最初の `undefined` でない結果が採用されます。フックのエラーはログに記録され、実行をクラッシュさせることなくスキップされます。

### カスタムツール

`api.registerTool(tool)` で `AgentTool` を登録します。TypeBox 互換のパラメータスキーマを使用し、標準のテキスト／画像ツールコンテンツを返してください。型付けされたツール実装については、完全な [`agent-pm` の例](https://github.com/geminixiang/mikan/tree/main/examples/extensions/agent-pm)を参照してください。

### コンテキストとストレージ

| API                       | 意味                                                           |
| ------------------------- | -------------------------------------------------------------- |
| `api.context`             | 会話 ID、ワークスペースディレクトリ、モデル、思考レベル        |
| `api.paths.dataDir`       | この拡張機能と会話用のプライベートデータ。デフォルトで使用する |
| `api.paths.sharedDataDir` | 会話間で共有するデータ。会話 ID で分割し、並行処理を自身で扱う |
| `api.log(message)`        | 拡張機能スコープの構造化ログエントリ                           |

インストールされたコードディレクトリ内には状態を保存しないでください。再インストールではコードが置き換えられる一方、拡張機能のデータは意図的に保持されます。

### シークレット

管理者は次の場所に `KEY=value` の行を書き込みます。

```text
<state-dir>/vaults/extensions/<slug>/env
```

値を公開せずに読み取ります。

```ts
const token = api.secrets.get("LINEAR_TOKEN");
const availableNames = api.secrets.list();
```

拡張機能 API を通じてシークレットにアクセスできるのは読み取り専用です。シークレットをログに記録したり、ツールの説明、プロンプト、スケジュールテキスト、返却コンテンツに含めたりしないでください。

### スケジュール、通知、リアクション

```ts
await api.schedules.upsert("daily-check", {
  type: "periodic",
  schedule: "0 9 * * 1-5",
  timezone: "Asia/Taipei",
  text: "Check overdue work. Report only actionable items.",
});

await api.notify("The scheduled check is ready.");
await api.react(messageTs, "white_check_mark");
```

スケジュールは mikan のイベントファイルを作成し、会話履歴を引き継がずに自律実行を開始するため、`text` は自己完結していなければなりません。複数のプラットフォームが実行中で推論が曖昧な場合は、`platform` を指定してください。スケジュールテキストにシークレットを含めないでください。

### 同梱スキル

拡張機能ディレクトリ内にスキルを配置します。

```text
hello-mikan/
├── index.ts
├── package.json
└── skills/
    └── hello-guide/
        └── SKILL.md
```

拡張機能のスキルは自動的に検出され、システムプロンプトにインライン化されます。これは、ホスト専用の拡張機能パスがサンドボックスにマウントされないためです。同名の会話スキルが優先されます。

## 6. ライフサイクルのルール

1. `activate` を冪等にしてください。`/pi-new` によって拡張機能が再度有効化される場合があります。このパターンでは `schedules.upsert` を安全に使用できます。
2. `setInterval`、サーバー、ウォッチャー、その他の長時間存続するリソースを作成しないでください。現在は無効化フックがないため、タイマーには `api.schedules` を使用してください。
3. デフォルトでは `api.paths.dataDir` を使用してください。意図的に複数の会話にまたがる動作をさせる場合にのみ `sharedDataDir` を使用してください。
4. 検証時にモジュールがインポートされるため、トップレベルのインポートと初期化を安全に保ってください。
5. 拡張機能の出力とツールパラメータを信頼境界として扱い、信頼できない入力を検証してください。

## 7. 更新、確認、削除

```bash
# Reinstall updates code and preserves extension data
mikan ext install ./hello-mikan --conversation <conversationId>

# Global extensions only
mikan ext list

# Global plus one conversation's extensions
mikan ext list --conversation <conversationId>

# Remove code; data remains on disk
mikan ext remove hello-mikan --conversation <conversationId>
```

更新または削除の後に `/pi-new` を送信してください。チャットでは、`/pi-extensions` に現在の会話から見える拡張機能が一覧表示されます。

## トラブルシューティング

| 症状                                     | 確認事項                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `No entrypoint found`                    | `package.json` に `mikan.extensions` を追加するか、`index.{mjs,js,ts,mts}` ファイルを追加する           |
| `does not export an activate function`   | `default function activate(...)` または名前付きの `activate` をエクスポートする                         |
| インストール済みだが有効でない           | `--state-dir` と会話 ID を確認してから、`/pi-new` を送信する                                            |
| インポート／モジュールエラー             | ローカルインストールの前にランタイム依存関係をインストールする。Git インストールでは npm は実行されない |
| schedule/notify/react が利用できない     | 実行中のプラットフォーム／コンテキストがそのホストサービスを提供していることを確認する                  |
| 拡張機能の識別子／データパスが正しくない | slug は編集可能なメタデータではなく、インストールされたファイル／ディレクトリ名から取得される           |

ツール、SQLite 永続化、スケジュール、プロアクティブメッセージ、同梱スキルをまとめて必要とする場合は、[`examples/extensions/agent-pm`](https://github.com/geminixiang/mikan/tree/main/examples/extensions/agent-pm) から始めてください。
