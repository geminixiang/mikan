---
title: 開發
description: 安裝依賴、建置 mikan、執行聚焦檢查、預覽文件，以及執行真實平台 E2E suites。
---

## 本機設定

mikan 需要 Node.js `>=22.19.0`。

```bash
git clone https://github.com/geminixiang/mikan.git
cd mikan
npm install --ignore-scripts
npm run build
```

未加 `--ignore-scripts` 的 `npm install` 會執行 repository 的 Husky `prepare` hook。需要本機 commit hooks 時再使用。

## 檢查

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

開發時先執行範圍最小的相關檢查，提交 pull request 前再執行 lint、format check、tests 與 build。

## 本機執行

使用獨立的 state directory，以免開發環境覆寫 production instance：

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

正常 bot 模式仍至少需要一組完整的平台憑證。

## 端對端測試

`e2e/` 下的 E2E suites 會呼叫真實平台 API，且不包含在 `npm test` 中：

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E 需要在專用測試 workspace 中設定 `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID` 與 `SLACK_QA_BOT_USER_ID`。設定與安全指引請參閱 [Slack QA 測試計畫](slack-qa-test-plan/)。
