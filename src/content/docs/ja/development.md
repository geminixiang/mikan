---
title: 開発
description: 依存関係のインストール、mikan のビルド、対象を絞ったチェック、ドキュメントのプレビュー、実プラットフォーム E2E suites の実行方法。
---

## ローカルセットアップ

mikan には Node.js `>=22.19.0` が必要です。

```bash
git clone https://github.com/geminixiang/mikan.git
cd mikan
npm install --ignore-scripts
npm run build
```

`--ignore-scripts` なしの `npm install` は、repository の Husky `prepare` hook を実行します。ローカル commit hooks が必要な場合に使用してください。

## リポジトリ構成

| パス                      | 内容                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `src/`                    | TypeScript ソース。各サブディレクトリには、その中のファイルを説明する `README.md` がある |
| `src/test/`               | Vitest suite。`.config/vitest.config.ts` は `src/test/**/*.test.ts` のみを対象にする     |
| `src/content/docs/`       | このドキュメントサイト（Starlight）と、`ja/`、`zh-cn/`、`zh-tw/` の各ロケール            |
| `src/tsconfig.build.json` | build 用の TypeScript project。root の `tsconfig.json` はエディタ向けツールを対象にする  |
| `.config/`                | ツール設定: Astro、Vitest（unit と E2E）、oxlint、oxfmt                                  |
| `deploy/`                 | デプロイ用アセット: `pm2/`、`docker/`、`examples/`（embedder、bridges）                  |
| `e2e/`                    | 実プラットフォームのエンドツーエンド suite。`npm test` からは除外される                  |
| `docs/adr/`               | アーキテクチャ決定記録                                                                   |
| `scripts/`                | npm scripts から呼び出される保守・検証スクリプト                                         |

## チェック

```bash
npm run dev                  # TypeScript build in watch mode
npm test                     # unit/integration tests (Vitest)
npm run test:coverage        # test coverage report
npm run lint                 # oxlint
npm run fmt:check            # oxfmt check; npm run fmt fixes files
npm run build                # clean dist/、型チェック、emit
npm run knip                 # dependency and export usage
npm run docs:build           # production documentation build
npm run docs:dev             # local documentation server
npm run docs:preview         # preview the built site after docs:build
```

各スクリプトは config を明示的に渡すため（例: `vitest --run --config .config/vitest.config.ts`）、どの working directory から実行しても同じ挙動になります。

対象を絞って実行するには、テストファイルの path を Vitest に渡します：

```bash
npm test -- src/test/office-layout.test.ts src/test/workspace-projection.test.ts
```

開発中は対象を絞った最小のチェックを実行し、pull request の前に lint、format check、tests、build を実行してください。

## Docker を使う office チェック

```bash
npm run test:office:docker
```

これは `npm test` には含まれません。動作する Docker daemon が必要だからです。2 つの office directory を作成して実際の container に mount し、symlink 経由も含めて、office が自分の mount の外を読めないことを実証します。`alpine:3.21` 以外の image を使うには `MIKAN_OFFICE_TEST_IMAGE` を設定します。

## ローカル実行

開発環境が本番 instance を上書きしないよう、別の state directory を使用します：

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

通常の bot mode には、少なくとも 1 組の完全な platform credentials が必要です。

その workspace の conversation directory は、生の platform id ではなく office key で命名されます。`./dist/main.js office list --state-dir="$HOME/.mikan-dev"` は registry — 各 office がどの platform とどの生 conversation id に属するか — と、保留中の migration を表示します。

## エンドツーエンドテスト

`e2e/` 下の E2E suites は実際のプラットフォーム API を呼び出すため、`npm test` には含まれません（`.config/vitest.e2e.config.ts` を使い、`e2e/**/*.e2e.ts` に一致し、single-forked で実行されます）：

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E には専用テスト workspace で `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID`、`SLACK_QA_BOT_USER_ID` を設定する必要があります。`SLACK_QA_WORKING_DIR` と `SLACK_QA_EVENTS_DIR` は、suite が監視する workspace と events directory を上書きします。どちらも既定ではリポジトリ内の `.workspace/` 配下です。設定方法と安全上の注意は [Slack QA test plan](/ja/slack-qa-test-plan/) を参照してください。
