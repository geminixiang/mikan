---
title: Development
description: Install dependencies, build mikan, run focused checks, preview documentation, and execute real-platform E2E suites.
---

## Local setup

mikan requires Node.js `>=22.19.0`.

```bash
git clone https://github.com/geminixiang/mikan.git
cd mikan
npm install --ignore-scripts
npm run build
```

`npm install` without `--ignore-scripts` runs the repository's Husky `prepare` hook. Use it when you want local commit hooks.

## Checks

```bash
npm run dev                  # TypeScript build in watch mode
npm test                     # unit/integration tests (Vitest)
npm run test:coverage        # test coverage report
npm run lint                 # oxlint
npm run fmt:check            # oxfmt check; npm run fmt fixes files
npm run build                # type check + emit dist/
npm run knip                 # dependency and export usage
npm run docs:build           # production documentation build
npm run docs:dev             # local documentation server
npm run docs:preview         # preview site-dist/ after docs:build
```

Run the smallest relevant check while developing, then run lint, format check, tests, and build before a pull request.

## Local runtime

Use a separate state directory so development does not overwrite a production instance:

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

At least one complete platform credential set is still required for normal bot mode.

## End-to-end tests

The E2E suites under `e2e/` call real platform APIs and are excluded from `npm test`:

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E requires `SLACK_QA_USER_TOKEN`, `SLACK_QA_CHANNEL_ID`, and `SLACK_QA_BOT_USER_ID` in a dedicated test workspace. See the [Slack QA test plan](/slack-qa-test-plan/) for setup and safety guidance.
