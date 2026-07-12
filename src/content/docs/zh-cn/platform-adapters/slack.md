---
title: Slack 适配器
description: Slack 适配器的 Socket Mode 事件、话题路由、Block Kit 和回复生命周期。
---

## 主要代码

| 文件                                       | 用途                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 核心：Socket Mode 事件、slash commands、Block Kit 操作、文件下载和消息发送。 |
| `src/adapters/slack/context.ts`            | 创建 Slack `ConversationResponder`；处理 mrkdwn、回复模式、工作状态和长消息。          |
| `src/adapters/slack/session.ts`            | Slack 频道/话题会话 key 规则。                                                         |
| `src/adapters/slack/response-lifecycle.ts` | Slack 回复生命周期和流式更新。                                                         |
| `src/adapters/slack/tools/*`               | Slack 专用工具，例如附件和 Block Kit 支持。                                            |

## 事件来源

Slack 适配器主要处理：

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-auto-reply`、`/pi-new` 等
- Block Kit 操作
- assistant 话题/状态 API

DM 会直接触发 mikan。共享频道消息需要提及、交互或匹配的自动回复策略。频道话题中普通的未提及人工回复会被记录，但不会触发运行；话题会话隔离不会绕过触发策略。

## 会话规则

Slack 有明确的频道和话题模型，因此会话 key 也相应分开：

| Slack 场景   | sessionKey           |
| ------------ | -------------------- |
| 频道顶层消息 | `channelId`          |
| 话题回复     | `channelId:threadTs` |
| 事件锚点运行 | `channelId:anchorTs` |

这样，频道对话和话题对话可以保留各自的会话上下文。

## 回复和格式

Slack 使用 mrkdwn，而不是普通 Markdown。适配器的平台格式指南要求代理使用：

- 粗体：`*text*`
- 斜体：`_text_`
- 代码：`` `code` ``
- 代码块：三个反引号
- 链接：`<url|text>`

Slack 适配器还支持：

- 顶层或话题回复模式
- 工作/assistant 状态
- 更新现有回复以显示流式进度
- 使用 Block Kit 渲染标题、段落、列表、代码围栏和表格
- 文件上传

Block Kit 输出遵循 Slack 限制：section 大约每 3,000 个字符拆分，表格单元格大约每 2,000 个字符拆分，一条消息最多 50 个 block。超过 block 上限的内容不会渲染，因此对于非常大的结构化结果，请使用文件输出。

## 附件

Slack 文件附件会下载到工作区的对话附件目录，然后作为共享 mikan 附件元数据传给运行时。

## 停止行为

`stop` / `/stop` 首先停止当前话题会话。如果在频道顶层使用，适配器会根据当前运行的会话判断能否安全停止匹配的会话。
