---
title: 开发
description: 安装依赖、构建 mikan、运行针对性检查、预览文档，以及执行真实平台 E2E 套件。
---

## 本地设置

mikan 需要 Node.js `>=22.19.0`。

```bash
git clone https://github.com/geminixiang/mikan.git
cd mikan
npm install --ignore-scripts
npm run build
```

不带 `--ignore-scripts` 的 `npm install` 会运行仓库的 Husky `prepare` hook。需要本地提交 hook 时使用它。

## 检查

```bash
npm run dev                  # TypeScript build in watch mode
npm test                     # unit/integration tests (Vitest)
npm run test:coverage        # test coverage report
npm run lint                 # oxlint
npm run fmt:check            # oxfmt check; npm run fmt fixes files
npm run build                # 清理 dist/、类型检查并输出
npm run knip                 # dependency and export usage
npm run docs:build           # production documentation build
npm run docs:dev             # local documentation server
npm run docs:preview         # preview site-dist/ after docs:build
```

开发时先运行最小的相关检查，然后在提交 pull request 前运行 lint、格式检查、测试和构建。

## 本地运行时

使用独立的 state directory，避免开发环境覆盖生产实例：

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

正常 bot 模式仍至少需要一套完整的平台凭证。

## 端到端测试

`e2e/` 下的 E2E 套件调用真实平台 API，不包含在 `npm test` 中：

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E 需要在专用测试工作区中设置 `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID` 和 `SLACK_QA_BOT_USER_ID`。设置和安全指南请参阅 [Slack QA 测试计划](/zh-cn/slack-qa-test-plan/)。
