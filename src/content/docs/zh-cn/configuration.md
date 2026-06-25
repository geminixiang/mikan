---
title: 设定
description: 设定全域与对话层级的模型、sandbox、Slack 回覆模式、auto-reply 与 vault 预设值。
---

每个对话的设定位于 `<working-directory>/<conversationId>/settings.json`，并会覆写该对话的全域设定。

## 范例

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  },
  "sentry": {
    "dsn": "https://examplePublicKey@o0.ingest.sentry.io/0"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    },
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  },
  "slack": {
    "replyMode": "top-level"
  }
}
```

## 栏位

| 栏位                           | 预设值              | 说明                                                  |
| ------------------------------ | ------------------- | ----------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | AI 供应商                                             |
| `llm.model`                    | `claude-sonnet-4-6` | 模型名称                                              |
| `llm.thinkingLevel`            | `off`               | `off` / `low` / `medium` / `high`                     |
| `sentry.dsn`                   | 未设定              | Sentry DSN；敏感的 prompt / tool 内容会被遮蔽         |
| `sandbox.cpus`                 | 未设定              | 受管理容器的 CPU 限制                                 |
| `sandbox.memory`               | 未设定              | 受管理容器的记忆体限制                                |
| `sandbox.boost.cpus`           | 未设定              | `/pi-sandbox boost` 使用的暂时 CPU 限制               |
| `sandbox.boost.memory`         | 未设定              | `/pi-sandbox boost` 使用的暂时记忆体限制              |
| `sandbox.image.workspaceMount` | `private`           | `private` 只挂载对话工作区；`full` 挂载整个工作区目录 |
| `sandbox.defaultSharedVault`   | 未设定              | 没有自有保管库的对话所使用的预设共享保管库键          |
| `slack.replyMode`              | `top-level`         | Slack 回应模式：`top-level` 或 `thread`               |

`/pi-sandbox` 会显示目前受管理容器的 CPU / 记忆体限制。`/pi-sandbox boost` 会暂时将 `sandbox.boost` 套用到目前对话；当该沙盒容器停止后，boost 也会结束。

对话本地设定使用相同结构，并会覆写该对话的全域设定。由 `/pi-model` 写入的设定通常只包含模型覆写：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  }
}
```

每个环境变数也支援 `MIKAN_` 前缀，用于部署专属的命名空间。例如，`MIKAN_SLACK_APP_TOKEN` 与 `MIKAN_LINK_URL` 都是可接受的 fallback。未加前缀的变数优先。

mikan 会将日志写到 stdout/stderr。请使用你的程序管理器或主机平台（例如 PM2、systemd、Docker，或云端日志代理）将日志导向偏好的后端。
