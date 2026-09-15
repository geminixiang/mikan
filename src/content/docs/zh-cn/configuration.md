---
title: 配置
description: 配置启动、全局和对话设置、平台凭证、沙箱限制及环境变量。
---

## 首次设置

mikan 正常启动前需要一个全局设置文件。创建并检查一次，然后使用工作区启动 mikan：

```bash
mikan onboard
mikan --sandbox=host /path/to/workspace
```

默认 state directory 是 `~/.mikan`。选择其他位置时，初始化和正常启动必须使用相同的 `--state-dir`：

```bash
mikan onboard --state-dir=/secure/mikan-state
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

`mikan onboard` 创建：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
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
    "defaultSharedVault": ""
  }
}
```

## 设置字段

以下值由初始化生成。解析后的全局配置中必须包含 `llm.provider`、`llm.model` 和 `llm.thinkingLevel`；其他字段可以省略。

| 字段                           | 初始化值            | 说明                                                                          |
| ------------------------------ | ------------------- | ----------------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | 主 AI 提供商                                                                  |
| `llm.model`                    | `claude-sonnet-4-6` | 主模型名称                                                                    |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`                   |
| `sentry.dsn`                   | 未设置              | Sentry DSN；敏感提示词和工具内容会被编辑隐藏                                  |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` 应用的临时 CPU 限制                                       |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` 应用的临时内存限制                                        |
| `sandbox.workspace.doorPolicy` | 未设置              | 显式覆盖：`isolated` 将办公室锁定在自身数据内；`trusted` 允许协作式工作区布局 |
| `sandbox.workspace.layout`     | 未设置              | 显式 trusted 布局覆盖：`shared-support` 或 `full`                             |
| `sandbox.workspace.visibility` | 未设置              | 在 `shared-support` 下，`public` 允许读写全局记忆，`private` 设为只读         |
| `sandbox.defaultSharedVault`   | 空                  | 复制到符合条件、基于成员身份信任的 image/Cloudflare 对话中的共享 vault        |
| `slack.replyMode`              | `top-level`         | Slack 回复模式：`top-level` 或 `thread`                                       |

`/pi-model` 写入部分对话覆盖，`/pi-sandbox door <default|isolated|shared|shared-private|full>` 写入该对话的 `sandbox.workspace` 覆盖值；管理 portal 既可以设置按办公室的门禁策略，也可以设置全局门禁策略。

Slack auto-reply 可通过 `/pi-auto-reply on|off` 修改，并以 conversation office 中的 `auto-reply`（on）或 `auto-reply.disabled`（off）标记文件保存。标记内容会被忽略：启用后，该 Slack channel 中未明确 address mikan 的 top-level human message 会直接触发，不使用 rules 或 judge model。Top-level `autoReply` 与 `llm.autoReply` JSON 设置仍保持退役并被忽略。

Onboarding 不会写入 `sandbox.workspace`。没有显式的全局或对话覆盖时，mikan 会跟随已记录的平台频道可见性。目前 Slack 公开频道解析为 `trusted` + `shared-support` + `public`，因此可以读写工作区全局 `MEMORY.md`；Slack 私密频道解析为 `trusted` + `shared-support` + `private`，全局记忆以只读方式挂载。Slack DM、外部共享频道、未知频道类型，以及未记录频道可见性的其他平台均解析为 `isolated`。这意味着新部署中的 Slack 公开频道无需额外门禁命令，就会向共享工作区记忆写入内容。

门禁策略和布局一起解析。`isolated` 始终意味着 `conversation` 布局：只挂载办公室自己的目录。`trusted` 则意味着 `shared-support`——办公室外加工作区级的 `MEMORY.md`、`skills/` 和 `events/`——或 `full`，即挂载整个工作区根目录。门禁策略为 `trusted` 而未指定布局时，解析为 `shared-support`。只有 `image:*` 能强制执行 isolated 投影或只读共享记忆；`host`、`container:*` 和 `cloudflare:*` 会对这些投影采取 fail-closed，因此必须改用 `image:*`，或显式选择 trusted 读写策略。

旧版 `sandbox.image.workspaceMount` 仍可读取以便迁移：旧的 `workspaceMount: "private"` 为维持原行为，表示 `trusted` + `shared-support` 且可见性为 **public/read-write**；它与新的 `sandbox.workspace.visibility: "private"` 不同，后者会将共享记忆设为只读。旧的 `workspaceMount: "full"` 表示 `trusted` + `full`。

## MCP servers

`mcpServers` 可连接 stdio 或 Streamable HTTP MCP server，并将工具公开为 `mcp__<server>__<tool>`。MCP server 在 host 端执行或连接，`env`／`headers` 中的凭证不会暴露给模型或 sandbox。

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "package@fixed-version"],
      "env": { "API_TOKEN": "..." }
    },
    "internal-docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

每个 entry 必须只使用一种 transport：`command`（可搭配 `args`、`env`）或 `url`（可搭配 `headers`）。`disabled: true` 可在不删除设置的情况下停用 server。全局和对话设置按 server name 合并；对话设置可以覆盖或停用同名的全局 server，其他全局 entries 仍会保留。

Admin 的 MCP 面板提供 repository-owned 的精选 Marketplace。安装前会显示完整 host command 或 remote endpoint、所需凭证、来源、目标 scope 和安全警告；确认后只会创建普通的 `mcpServers` entry。Local package 版本固定，不另建 installed database 或自动更新服务，也不把 catalog 收录视为安全认证。Local stdio preset 会在 mikan host 执行代码；remote preset 则会收到发往其工具的调用和数据。

OpenConnector 是一个附带部署默认值的普通 MCP server。`OPENCONNECTOR_ENDPOINT` 指定默认的 `open-connector` server，`OPENCONNECTOR_ADMIN_TOKEN` 是 host-only 的凭证，用于为各 conversation 生成 runtime token。当 Slack conversation 未在 global 或 conversation 设置中声明 `open-connector` 时，mikan 会创建名为 `mikan:slack:<workspace-id>:<channel-id>` 的 token（复制当前 OpenConnector deployment 的 action／proxy policy），并以普通 `mcpServers` entry 的形式写入该 conversation 的 host-only settings。之后该 entry 会出现在 Admin MCP 面板，可像其他 server 一样测试、停用、移除，或替换为自建的 OpenConnector；移除后下次回复会重新生成默认 entry，停用则关闭集成。Admin token 只会发送到默认 endpoint 的 origin，不会进入 settings 或 sandbox。既有的 `open-connector-runtime-token.json` 可在停止 daemon 后用 `mikan office migrate-openconnector` 转换。

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

| 命令或选项                                                         | 用途                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `mikan onboard [--state-dir=<dir>]`                                | 创建必需的全局设置文件                                       |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] [working-directory]` | 启动已配置的平台 bot；工作目录默认为 `<state-dir>/workspace` |
| `mikan env`                                                        | 显示完整的环境变量清单及当前的设置状态                       |
| `mikan --download <channel-id>`                                    | 下载 Slack 频道历史记录；需要 `SLACK_BOT_TOKEN`              |
| `mikan --version`                                                  | 输出已安装版本                                               |
| `mikan --help`                                                     | 显示 CLI 用法与平台令牌摘要                                  |
| `mikan office list`                                                | 列出已注册的办公室、已启用的平台，以及待处理的旧版迁移       |
| `mikan office claim <conversationId> <platform>`                   | 为启动时无法归属的旧版原始 id 目录指明其所属平台             |

`mikan office` 接受 `--state-dir <dir>` 和 `--workspace <dir>`；工作区默认为 `<state-dir>/workspace`。`claim` 只记录该决定——实际移动由 daemon 在下次启动时执行，因此请在 daemon 停止的状态下运行它。

## Observability：OTLP、Sentry 与 Phoenix

mikan 只维护一条 OpenTelemetry traces/metrics pipeline，并通过标准 OTLP HTTP/protobuf 导出。只有明确配置 OTLP endpoint 且 `OTEL_SDK_DISABLED` 不是 `true` 时才启用；零配置保持 no-op。Collector 可使用 `OTEL_EXPORTER_OTLP_ENDPOINT`，也可分别设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 和 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`。base endpoint 会附加 `/v1/traces`、`/v1/metrics`，per-signal endpoint 必须包含完整路径。认证信息应放在对应的 `*_HEADERS`，不要写入 URL。

本地 [Arize Phoenix](https://github.com/Arize-ai/phoenix) 可设置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces`。Phoenix 接收 traces，不提供 OTLP metrics ingestion；metrics 请发送到 Collector 或其他 backend。mikan 在同一组 spans 上输出不含内容的标准 GenAI attributes 和最小 OpenInference projection，保留 provider、model、token counts、duration、status、session attribution和 tool name，不生成重复 spans。

`SENTRY_DSN`（或兼容的 `sentry.dsn`）启用 Sentry issue reporting，并把错误链接到当前 OpenTelemetry trace；Sentry 不会创建第二条 application trace/metric pipeline。如需把同一份 traces 同时发送到 Phoenix 和 Sentry，请使用 OpenTelemetry Collector fan-out。Sentry direct OTLP 当前支持 traces/logs，不支持 OTLP metrics。

仅支持 `http/protobuf`；`OTEL_TRACES_EXPORTER=none`、`OTEL_METRICS_EXPORTER=none` 可分别关闭 signal。mikan 不会输出 prompts、completions、消息文本、tool arguments/results、文件内容、credentials、tokens 或绝对路径；但会输出 model ID、token/cost 总量、耗时、payload 大小、tool 类别，以及 retry/compaction/budget 次数等无内容的操作 metadata。平台 conversation、session、message、thread 与 user identifiers 会以 raw operational ID 导出，让 trace 能直接对应来源；human-readable username、channel name 与 workspace name 仍不会输出。resource attributes 采用 allowlist，请勿在 `OTEL_RESOURCE_ATTRIBUTES` 中放入 secrets 或 paths。shutdown 会先 drain conversation work，再 flush/shutdown OTLP，最后 close Sentry。

## 环境变量别名

通过 mikan 配置辅助程序读取的环境变量也接受 `MIKAN_` 前缀。例如，`MIKAN_SLACK_APP_TOKEN` 和 `MIKAN_LINK_URL` 是 `SLACK_APP_TOKEN` 和 `LINK_URL` 的后备值；无前缀值优先。`SENTRY_DSN` 是例外：请直接配置它，或在 `settings.json` 中设置 `sentry.dsn`。

daemon 的完整环境接口在源码树中以 manifest 声明；`mikan env` 会打印按平台和功能分组的带注释清单，并附上每个变量的当前状态，让你无需阅读代码即可审计一次部署。

mikan 将日志写入 stdout/stderr。请使用 PM2、systemd、Docker 或托管平台路由并保留日志。
