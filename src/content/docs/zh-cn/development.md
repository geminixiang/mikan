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

## 仓库布局

| 路径                      | 内容                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `src/`                    | TypeScript 源码；每个子目录都有自己的 `README.md` 说明其文件               |
| `src/test/`               | Vitest 测试套件。`.config/vitest.config.ts` 只包含 `src/test/**/*.test.ts` |
| `src/content/docs/`       | 本文档站点（Starlight），以及 `ja/`、`zh-cn/` 和 `zh-tw/` 语言树           |
| `src/tsconfig.build.json` | 构建用的 TypeScript project；根 `tsconfig.json` 覆盖编辑器工具             |
| `.config/`                | 工具配置：Astro、Vitest（单元与 E2E）、oxlint、oxfmt                       |
| `deploy/`                 | 部署资源：`pm2/`、`docker/` 和 `examples/`（embedder、bridge）             |
| `e2e/`                    | 真实平台端到端套件，不包含在 `npm test` 中                                 |
| `docs/adr/`               | 架构决策记录                                                               |
| `scripts/`                | 由 npm script 调用的维护与验证脚本                                         |

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
npm run docs:preview         # preview the built site after docs:build
```

每个 script 都显式传入自己的配置（例如 `vitest --run --config .config/vitest.config.ts`），因此这些命令在任何工作目录下行为一致。

想做针对性运行时，把测试文件路径透传给 Vitest：

```bash
npm test -- src/test/office-layout.test.ts src/test/workspace-projection.test.ts
```

开发时先运行最小的相关检查，然后在提交 pull request 前运行 lint、格式检查、测试和构建。

## 基于 Docker 的办公室检查

```bash
npm run test:office:docker
```

这一项不属于 `npm test`：它需要可用的 Docker daemon。它会创建两个办公室目录并把它们挂载进真实容器，以证明一间办公室无法读取其自身 mount 之外的内容，包括通过 symlink。设置 `MIKAN_OFFICE_TEST_IMAGE` 可以使用 `alpine:3.21` 以外的镜像。

## 本地运行时

使用独立的 state directory，避免开发环境覆盖生产实例：

```bash
./dist/main.js --onboard --state-dir="$HOME/.mikan-dev"
./dist/main.js --state-dir="$HOME/.mikan-dev" --sandbox=host /path/to/workspace
```

正常 bot 模式仍至少需要一套完整的平台凭证。

该工作区中的对话目录按 office key 命名，而不是按原始平台 id。`./dist/main.js office list --state-dir="$HOME/.mikan-dev"` 会打印注册表——每间办公室属于哪个平台和哪个原始对话 id——以及任何仍待处理的迁移。

## 端到端测试

`e2e/` 下的 E2E 套件调用真实平台 API，不包含在 `npm test` 中（它们使用 `.config/vitest.e2e.config.ts`，匹配 `e2e/**/*.e2e.ts` 并以 single-forked 方式运行）：

```bash
npm run test:e2e          # all configured platforms
npm run test:e2e:slack    # Slack only
```

Slack E2E 需要在专用测试工作区中设置 `SLACK_QA_USER_TOKEN`、`SLACK_QA_CHANNEL_ID` 和 `SLACK_QA_BOT_USER_ID`。`SLACK_QA_WORKING_DIR` 和 `SLACK_QA_EVENTS_DIR` 可覆盖该套件监视的工作区与事件目录；两者默认都位于仓库的 `.workspace/` 下。设置和安全指南请参阅 [Slack QA 测试计划](/zh-cn/slack-qa-test-plan/)。
