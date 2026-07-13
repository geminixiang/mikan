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

| 范围 | 路径                                                       | 用途                   |
| ---- | ---------------------------------------------------------- | ---------------------- |
| 全局 | `<state-dir>/settings.json`                                | 所有对话必需的默认设置 |
| 对话 | `<state-dir>/conversations/<conversationId>/settings.json` | 一个对话的部分覆盖     |

对话设置以主机为准。旧版 `<workspace>/<conversationId>/settings.json` 文件会在首次访问时迁移，之后不再从沙箱可见的工作区读取。

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
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  }
}
```

## 设置字段

以下值由初始化生成。解析后的全局配置中必须包含 `llm.provider`、`llm.model` 和 `llm.thinkingLevel`；其他字段可以省略。

| 字段                           | 初始化值            | 说明                                                                   |
| ------------------------------ | ------------------- | ---------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | 主 AI 提供商                                                           |
| `llm.model`                    | `claude-sonnet-4-6` | 主模型名称                                                             |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`            |
| `llm.autoReply.provider`       | `anthropic`         | 用于评估自动回复规则的可选模型提供商                                   |
| `llm.autoReply.model`          | `claude-haiku-4-5`  | 用于评估自动回复规则的可选模型                                         |
| `sentry.dsn`                   | 未设置              | Sentry DSN；敏感提示词和工具内容会被编辑隐藏                           |
| `sandbox.cpus`                 | `0.5`               | mikan 管理的 image 容器 CPU 限制                                       |
| `sandbox.memory`               | `1g`                | mikan 管理的 image 容器内存限制                                        |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` 应用的临时 CPU 限制                                |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` 应用的临时内存限制                                 |
| `sandbox.image.workspaceMount` | `private`           | `private` 暴露共享支持文件及当前对话；`full` 暴露完整工作区            |
| `sandbox.defaultSharedVault`   | 空                  | 复制到符合条件、基于成员身份信任的 image/Cloudflare 对话中的共享 vault |
| `slack.replyMode`              | `top-level`         | Slack 回复模式：`top-level` 或 `thread`                                |

`/pi-model` 写入部分对话覆盖。`/pi-sandbox private|full` 更新对话的工作区挂载模式。自动回复的启用状态和规则文本由 `/pi-auto-reply` 及对话的 `auto-reply` 标记文件管理，不由 JSON 设置字段管理。

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

| 命令或选项                                                                                  | 用途                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `mikan --onboard [--state-dir=<dir>]`                                                       | 创建必需的全局设置文件                           |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] <workspace>`                                  | 启动已配置的平台 bot                             |
| `--sandbox=host \| container:<name> \| image:<image> \| firecracker:... \| cloudflare:<id>` | 选择工具执行模式；默认为 `host`                  |
| `mikan --download <channel-id>`                                                             | 下载 Slack 频道历史记录；需要 `SLACK_BOT_TOKEN`  |
| `mikan --version`                                                                           | 输出已安装版本                                   |
| `mikan ext ...`                                                                             | 管理框架扩展；运行 `mikan ext --help` 查看子命令 |

## 环境变量别名

通过 mikan 配置辅助程序读取的环境变量也接受 `MIKAN_` 前缀。例如，`MIKAN_SLACK_APP_TOKEN` 和 `MIKAN_LINK_URL` 是 `SLACK_APP_TOKEN` 和 `LINK_URL` 的后备值；无前缀值优先。`SENTRY_DSN` 是例外：请直接配置它，或在 `settings.json` 中设置 `sentry.dsn`。

mikan 将日志写入 stdout/stderr。请使用 PM2、systemd、Docker 或托管平台路由并保留日志。
