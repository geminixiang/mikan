---
title: 开发
description: mikan 开发环境、测试、格式化、建置与本机执行方式。
---

```bash
npm run dev         # 以 watch mode 建置
npm test            # unit tests (vitest)
npm run lint        # oxlint
npm run fmt:check   # oxfmt（使用 `npm run fmt` 自動修正）
npm run build       # type check + 輸出 dist/
```

## 端对端测试

`e2e/` 下的 E2E suites 会使用真实平台 API，不包含在预设的 `npm test` 执行中。

```bash
npm run test:e2e          # 所有平台
npm run test:e2e:slack    # 僅 Slack
```

Slack E2E 需要在专用测试 workspace 中设定 `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID` 与 `SLACK_QA_BOT_USER_ID`。设定方式请见 [`slack-qa-test-plan.md`](slack-qa-test-plan.md)。
