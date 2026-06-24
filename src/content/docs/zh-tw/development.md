---
title: 開發
description: mikan 開發環境、測試、格式化、建置與本機執行方式。
---

```bash
npm run dev         # 以 watch mode 建置
npm test            # unit tests (vitest)
npm run lint        # oxlint
npm run fmt:check   # oxfmt（使用 `npm run fmt` 自動修正）
npm run build       # type check + 輸出 dist/
```

## 端對端測試

`e2e/` 下的 E2E suites 會使用真實平台 API，不包含在預設的 `npm test` 執行中。

```bash
npm run test:e2e          # 所有平台
npm run test:e2e:slack    # 僅 Slack
```

Slack E2E 需要在專用測試 workspace 中設定 `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID` 與 `SLACK_QA_BOT_USER_ID`。設定方式請見 [`slack-qa-test-plan.md`](slack-qa-test-plan.md)。
