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

## Repository 佈局

| 路徑                      | 內容                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `src/`                    | TypeScript 原始碼；每個子目錄都有自己的 `README.md` 說明其中的檔案          |
| `src/test/`               | Vitest suite。`.config/vitest.config.ts` 只納入 `src/test/**/*.test.ts`     |
| `src/content/docs/`       | 這個文件站台（Starlight），以及 `ja/`、`zh-cn/`、`zh-tw/` 語系              |
| `src/tsconfig.build.json` | build 使用的 TypeScript project；根目錄的 `tsconfig.json` 供編輯器工具用    |
| `.config/`                | 工具設定：Astro、Vitest（unit 與 E2E）、oxlint、oxfmt                       |
| `deploy/`                 | 部署資產：`pm2/`、`docker/` 與 `examples/`（embedder、extensions、bridges） |
| `e2e/`                    | 真實平台的端對端 suites，不包含在 `npm test` 中                             |
| `docs/adr/`               | 架構決策紀錄                                                                |
| `scripts/`                | 由 npm scripts 呼叫的維護與驗證腳本                                         |

## 檢查

```bash
npm run dev                  # TypeScript build in watch mode
npm test                     # unit/integration tests (Vitest)
npm run test:coverage        # test coverage report
npm run lint                 # oxlint
npm run fmt:check            # oxfmt check; npm run fmt fixes files
npm run build                # 清理 dist/、type check 並輸出
npm run knip                 # dependency and export usage
npm run docs:build           # production documentation build
npm run docs:dev             # local documentation server
npm run docs:preview         # preview the built site after docs:build
```

每個 script 都會明確傳入自己的 config（例如 `vitest --run --config .config/vitest.config.ts`），因此不論從哪個工作目錄執行，行為都相同。

把測試檔案路徑傳給 Vitest，就能只跑指定範圍：

```bash
npm test -- src/test/office-layout.test.ts src/test/workspace-projection.test.ts
```

開發時先執行範圍最小的相關檢查，提交 pull request 前再執行 lint、format check、tests 與 build。

## 以 Docker 執行的 office 檢查

```bash
npm run test:office:docker
```

這一項不屬於 `npm test`：它需要可運作的 Docker daemon。它會建立兩個 office 目錄並掛進真實的 container，用來證明一個 office 無法讀取自己 mount 之外的內容，連透過 symlink 也不行。若要使用 `alpine:3.21` 以外的 image，請設定 `MIKAN_OFFICE_TEST_IMAGE`。

## 本機執行

使用獨立的 state directory，以免開發環境覆寫 production instance：

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

正常 bot 模式仍至少需要一組完整的平台憑證。

該 workspace 中的對話目錄是以 office key 命名，而不是原始平台 id。`./dist/main.js office list --state-dir="$HOME/.mikan-dev"` 會印出 registry——每個 office 屬於哪個平台與哪個原始 conversation id——以及任何尚未完成的遷移。

## 端對端測試

`e2e/` 下的 E2E suites 會呼叫真實平台 API，且不包含在 `npm test` 中（它們使用 `.config/vitest.e2e.config.ts`，比對 `e2e/**/*.e2e.ts` 並以 single-fork 執行）：

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E 需要在專用測試 workspace 中設定 `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID` 與 `SLACK_QA_BOT_USER_ID`。`SLACK_QA_WORKING_DIR` 與 `SLACK_QA_EVENTS_DIR` 可覆寫該 suite 監看的 workspace 與 events 目錄；兩者預設都在 repo 的 `.workspace/` 底下。設定與安全指引請參閱 [Slack QA 測試計畫](/zh-tw/slack-qa-test-plan/)。
