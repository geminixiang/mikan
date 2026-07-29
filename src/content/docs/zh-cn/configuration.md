---
title: 配置
description: 配置启动、全局和对话设置、平台凭证、沙箱限制及环境变量。
---

## 首次设置

mikan 正常启动前需要一个全局设置文件。创建并检查一次，然后使用工作区启动 mikan：

```bash
mikan --onboard
mikan --sandbox=host /path/to/workspace
```

默认 state directory 是 `~/.mikan`。选择其他位置时，初始化和正常启动必须使用相同的 `--state-dir`：

```bash
mikan --onboard --state-dir=/secure/mikan-state
mikan --state-dir=/secure/mikan-state /path/to/workspace
```

mikan 创建缺失的 state directory 时使用 `0700` 模式。现有目录必须归当前用户所有，且不能全局可写。对于沙箱模式，请将其放在工作区之外，使工具无法访问凭证或管理员设置。

## 设置位置

| 范围 | 路径                                                  | 用途                   |
| ---- | ----------------------------------------------------- | ---------------------- |
| 全局 | `<state-dir>/settings.json`                           | 所有对话必需的默认设置 |
| 对话 | `<state-dir>/conversations/<officeKey>/settings.json` | 一个对话的部分覆盖     |

对话设置以主机为准。旧版 `<workspace>/<officeKey>/settings.json` 文件会在首次访问时迁移，之后不再从沙箱可见的工作区读取。

### Office key

每个对话都是一间**办公室**，由其平台加上该平台的原始对话 id 标识。存储路径使用由两者派生的 office key——`v1-<platform>-<readable-id>-<hash>`，例如 `v1-slack-c0aaaaaa1-1f4b9c0d2e3a5b7c`——因此两个恰好共用同一原始对话 id 的平台，永远无法访问彼此的文件、设置或凭证。同一个 key 同时命名工作区中的办公室目录、它的 state directory 和它的 vault。

office key 无法反推回原始平台 id，因此主机会在 `<state-dir>/office-registry.json` 维护一个注册表，记录每间办公室的平台和对话 id。用 `mikan office list` 可以读取它。

从以原始平台 id 存储对话的版本升级时，这些目录、vault 和 state 树会在下次启动时迁移到 office key 布局；参阅[部署](/zh-cn/deployment/#跨办公室布局迁移升级)。

## 生成的设置

`mikan --onboard` 创建：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off",
    "autoReply": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5"
    }
  },
  "slack": {
    "replyMode": "top-level"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "1g",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    },
    "workspace": {
      "doorPolicy": "isolated"
    },
    "defaultSharedVault": ""
  }
}
```

## 设置字段

以下值由初始化生成。解析后的全局配置中必须包含 `llm.provider`、`llm.model` 和 `llm.thinkingLevel`；其他字段可以省略。

| 字段                           | 初始化值            | 说明                                                                                 |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| `llm.provider`                 | `anthropic`         | 主 AI 提供商                                                                         |
| `llm.model`                    | `claude-sonnet-4-6` | 主模型名称                                                                           |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`                          |
| `llm.autoReply.provider`       | `anthropic`         | 用于评估自动回复规则的可选模型提供商                                                 |
| `llm.autoReply.model`          | `claude-haiku-4-5`  | 用于评估自动回复规则的可选模型                                                       |
| `sentry.dsn`                   | 未设置              | Sentry DSN；敏感提示词和工具内容会被编辑隐藏                                         |
| `sandbox.cpus`                 | `0.5`               | mikan 管理的 image/Gondolin runtime CPU 限制；Gondolin 会把小数值向上取整为整数 vCPU |
| `sandbox.memory`               | `1g`                | mikan 管理的 image/Gondolin runtime 内存限制                                         |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` 应用的临时 CPU 限制                                              |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` 应用的临时内存限制                                               |
| `sandbox.workspace.doorPolicy` | `isolated`          | `isolated` 将每个对话锁定在它自己的办公室数据内；`trusted` 显式允许协作式工作区布局  |
| `sandbox.workspace.layout`     | `conversation`      | 生效布局：isolated 始终使用 `conversation`；trusted 使用 `shared-support` 或 `full`  |
| `sandbox.defaultSharedVault`   | 空                  | 复制到符合条件、基于成员身份信任的 image/Cloudflare 对话中的共享 vault               |
| `slack.replyMode`              | `top-level`         | Slack 回复模式：`top-level` 或 `thread`                                              |

`/pi-model` 写入部分对话覆盖，`/pi-sandbox door <default|isolated|shared|full>` 写入该对话的 `sandbox.workspace` 覆盖值；管理 portal 既可以设置按办公室的门禁策略，也可以设置全局门禁策略。自动回复的启用状态和规则文本由 `/pi-auto-reply` 及对话的 `auto-reply` 标记文件管理，不由 JSON 设置字段管理。

门禁策略和布局一起解析。`isolated` 始终意味着 `conversation` 布局：只挂载办公室自己的目录。`trusted` 则意味着 `shared-support`——办公室外加工作区级的 `MEMORY.md`、`skills/` 和 `events/`——或 `full`，即挂载整个工作区根目录。门禁策略为 `trusted` 而未指定布局时，解析为 `shared-support`。

旧版 `sandbox.image.workspaceMount` 仍可读取以便迁移：`private` 表示 `trusted` + `shared-support`，`full` 表示 `trusted` + `full`。全新安装写入规范的、与后端无关的设置，并默认为 `isolated`。

## 平台凭证

正常 bot 模式至少需要一套完整的平台凭证：

| 平台     | 必需环境变量                                                                                              | 可选变量                               |
| -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Slack    | `SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN`                                                                      | —                                      |
| Telegram | `TELEGRAM_BOT_TOKEN`                                                                                      | —                                      |
| Discord  | `DISCORD_BOT_TOKEN`                                                                                       | —                                      |
| GitHub   | `GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID`，以及 `GITHUB_APP_PRIVATE_KEY` 或 `GITHUB_APP_PRIVATE_KEY_PATH` | `GITHUB_REPOS`、`GITHUB_POLL_INTERVAL` |

有关各平台的设置和权限，请参阅[平台适配器](/zh-cn/platform-adapters/)。

## CLI 参考

| 命令或选项                                                                                                      | 用途                                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `mikan --onboard [--state-dir=<dir>]`                                                                           | 创建必需的全局设置文件                                       |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] [working-directory]`                                              | 启动已配置的平台 bot；工作目录默认为 `<state-dir>/workspace` |
| `--sandbox=host \| container:<name> \| image:<image> \| gondolin:default \| firecracker:... \| cloudflare:<id>` | 选择工具执行模式；默认为 `host`                              |
| `mikan env`                                                                                                     | 显示完整的环境变量清单及当前的设置状态                       |
| `mikan --download <channel-id>`                                                                                 | 下载 Slack 频道历史记录；需要 `SLACK_BOT_TOKEN`              |
| `mikan --version`                                                                                               | 输出已安装版本                                               |
| `mikan --help`                                                                                                  | 显示 CLI 用法与平台令牌摘要                                  |
| `mikan ext ...`                                                                                                 | 管理框架扩展；运行 `mikan ext` 查看子命令                    |
| `mikan office list`                                                                                             | 列出已注册的办公室、已启用的平台，以及待处理的旧版迁移       |
| `mikan office claim <conversationId> <platform>`                                                                | 为启动时无法归属的旧版原始 id 目录指明其所属平台             |

`mikan office` 接受 `--state-dir <dir>` 和 `--workspace <dir>`；工作区默认为 `<state-dir>/workspace`。`claim` 只记录该决定——实际移动由 daemon 在下次启动时执行，因此请在 daemon 停止的状态下运行它。

## 环境变量别名

通过 mikan 配置辅助程序读取的环境变量也接受 `MIKAN_` 前缀。例如，`MIKAN_SLACK_APP_TOKEN` 和 `MIKAN_LINK_URL` 是 `SLACK_APP_TOKEN` 和 `LINK_URL` 的后备值；无前缀值优先。`SENTRY_DSN` 是例外：请直接配置它，或在 `settings.json` 中设置 `sentry.dsn`。

daemon 的完整环境接口在源码树中以 manifest 声明；`mikan env` 会打印按平台和功能分组的带注释清单，并附上每个变量的当前状态，让你无需阅读代码即可审计一次部署。

mikan 将日志写入 stdout/stderr。请使用 PM2、systemd、Docker 或托管平台路由并保留日志。
