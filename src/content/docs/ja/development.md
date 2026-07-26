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
npm run docs:preview         # preview site-dist/ after docs:build
```

開発中は対象を絞った最小のチェックを実行し、pull request の前に lint、format check、tests、build を実行してください。

## ローカル実行

開発環境が本番 instance を上書きしないよう、別の state directory を使用します：

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

通常の bot mode には、少なくとも 1 組の完全な platform credentials が必要です。

## エンドツーエンドテスト

`e2e/` 下の E2E suites は実際のプラットフォーム API を呼び出すため、`npm test` には含まれません：

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E には専用テスト workspace で `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID`、`SLACK_QA_BOT_USER_ID` を設定する必要があります。設定方法と安全上の注意は [Slack QA test plan](/ja/slack-qa-test-plan/) を参照してください。
