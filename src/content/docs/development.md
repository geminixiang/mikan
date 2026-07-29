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

## Repository layout

| Path                      | Contents                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `src/`                    | TypeScript source; each subdirectory has its own `README.md` describing its files     |
| `src/test/`               | The Vitest suite. `.config/vitest.config.ts` includes only `src/test/**/*.test.ts`    |
| `src/content/docs/`       | This documentation site (Starlight), plus the `ja/`, `zh-cn/`, and `zh-tw/` locales   |
| `src/tsconfig.build.json` | The build's TypeScript project; the root `tsconfig.json` covers editor tooling        |
| `.config/`                | Tool configuration: Astro, Vitest (unit and E2E), oxlint, oxfmt                       |
| `deploy/`                 | Deployment assets: `pm2/`, `docker/`, and `examples/` (embedder, extensions, bridges) |
| `e2e/`                    | Real-platform end-to-end suites, excluded from `npm test`                             |
| `docs/adr/`               | Architecture decision records                                                         |
| `scripts/`                | Maintenance and verification scripts invoked from npm scripts                         |

## Checks

```bash
npm run dev                  # TypeScript build in watch mode
npm test                     # unit/integration tests (Vitest)
npm run test:coverage        # test coverage report
npm run lint                 # oxlint
npm run fmt:check            # oxfmt check; npm run fmt fixes files
npm run build                # clean dist/, then type check + emit
npm run knip                 # dependency and export usage
npm run docs:build           # production documentation build
npm run docs:dev             # local documentation server
npm run docs:preview         # preview the built site after docs:build
```

Every script passes its config explicitly (for example `vitest --run --config .config/vitest.config.ts`), so the commands behave the same from any working directory.

Pass test file paths through to Vitest for a focused run:

```bash
npm test -- src/test/office-layout.test.ts src/test/workspace-projection.test.ts
```

Run the smallest relevant check while developing, then run lint, format check, tests, and build before a pull request.

## Docker-backed office check

```bash
npm run test:office:docker
```

This one is not part of `npm test`: it needs a working Docker daemon. It creates two office directories and mounts them into real containers to prove an office cannot read outside its own mount, including through symlinks. Set `MIKAN_OFFICE_TEST_IMAGE` to use an image other than `alpine:3.21`.

## Local runtime

Use a separate state directory so development does not overwrite a production instance:

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

At least one complete platform credential set is still required for normal bot mode.

Conversation directories in that workspace are named by office key, not by raw platform id. `./dist/main.js office list --state-dir="$HOME/.mikan-dev"` prints the registry — which platform and raw conversation id each office belongs to — plus any migration still pending.

## End-to-end tests

The E2E suites under `e2e/` call real platform APIs and are excluded from `npm test` (they use `.config/vitest.e2e.config.ts`, which matches `e2e/**/*.e2e.ts` and runs single-forked):

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E requires `SLACK_QA_USER_TOKEN`, `SLACK_QA_CHANNEL_ID`, and `SLACK_QA_BOT_USER_ID` in a dedicated test workspace. `SLACK_QA_WORKING_DIR` and `SLACK_QA_EVENTS_DIR` override the workspace and events directory the suite watches; both default under `.workspace/` in the repo. See the [Slack QA test plan](/slack-qa-test-plan/) for setup and safety guidance.
