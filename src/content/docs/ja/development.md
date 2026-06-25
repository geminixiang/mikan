---
title: 開発
description: mikan の開発環境、テスト、フォーマット、ビルド、ローカル実行方法。
---

```bash
npm run dev         # watch mode でビルド
npm test            # unit tests (vitest)
npm run lint        # oxlint
npm run fmt:check   # oxfmt（`npm run fmt` で自動修正）
npm run build       # type check + dist/ 出力
```

## エンドツーエンドテスト

`e2e/` 下の E2E suites は実際のプラットフォーム API を使うため、既定の `npm test` には含まれません。

```bash
npm run test:e2e          # すべてのプラットフォーム
npm run test:e2e:slack    # Slack のみ
```

Slack E2E には専用テスト workspace で `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID`、`SLACK_QA_BOT_USER_ID` を設定する必要があります。設定方法は [`slack-qa-test-plan.md`](slack-qa-test-plan.md) を参照してください。
