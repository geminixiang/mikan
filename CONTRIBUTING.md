# Contributing to mikan

Thanks for your interest! mikan is a small project, so the process is lightweight.

## Development setup

Requires Node.js >= 22.19.0.

```bash
git clone https://github.com/geminixiang/mikan.git
cd mikan
npm install
npm run build
```

To run mikan locally against your own working directory:

```bash
./dist/main.js --state-dir=~/.mikan-dev /path/to/workspace
```

Set the platform tokens you need before launching — see the [README](README.md#quick-start) for the env-var list.

## Running checks

```bash
npm run lint        # oxlint
npm run fmt:check   # oxfmt (use `npm run fmt` to auto-fix)
npm test            # unit tests (vitest)
npm run build       # type check + emit dist/
```

Husky runs `lint` + `fmt` on staged `*.ts` files via pre-commit; `*.test.ts` changes also trigger the test suite. If hooks block your commit, fix the underlying issue rather than passing `--no-verify`.

### End-to-end tests

E2E tests (`npm run test:e2e`, `npm run test:e2e:slack`) hit real Slack/Discord/Telegram APIs. They require a dedicated test workspace and tokens (`SLACK_QA_USER_TOKEN`, `SLACK_QA_CHANNEL_ID`, `SLACK_QA_MIKAN_BOT_USER_ID` for Slack). Skip them locally unless you have a sandbox set up — CI runs them on tagged branches.

See [`docs/slack-qa-test-plan.md`](docs/slack-qa-test-plan.md) for the Slack E2E setup.

## Submitting changes

1. Open an issue first for non-trivial work so we can agree on the approach.
2. Fork, branch, and open a PR against `main`. Keep PRs focused on one concern.
3. Reference the issue in the PR body and describe what you tested.
4. CI must pass (lint, tests, build) before merge.

## Commit style

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) loosely: `feat(scope): summary`, `fix(scope): summary`, `refactor(scope): …`, `docs(scope): …`, `chore(scope): …`. Scope is usually a top-level module name (`slack`, `agent`, `vault`, `session`, …). Keep the summary in imperative mood and under ~72 chars.

## Reporting bugs

Open an issue using the bug-report template. Include the mikan version (`mikan --version` or `package.json`), Node version, sandbox mode, and the smallest reproduction you can manage. Redact tokens before pasting logs.

## Code of conduct

Be respectful. Disagreements about technical direction are welcome; personal attacks are not. Maintainers may close or lock threads that violate this.
