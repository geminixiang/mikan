---
title: Development
description: mikan development environment, tests, formatting, build, and local run commands.
---

```bash
npm run dev         # build in watch mode
npm test            # unit tests (vitest)
npm run lint        # oxlint
npm run fmt:check   # oxfmt (use `npm run fmt` to fix automatically)
npm run build       # type check + emit dist/
```

## End-to-end tests

The E2E suites under `e2e/` use real platform APIs and are not included in the default `npm test` run.

```bash
npm run test:e2e          # all platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E requires `SLACK_QA_USER_TOKEN`, `SLACK_QA_CHANNEL_ID`, and `SLACK_QA_BOT_USER_ID` in a dedicated test workspace. See [`slack-qa-test-plan.md`](slack-qa-test-plan.md) for setup.
