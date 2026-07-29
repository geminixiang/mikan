---
title: Slack 适配器
description: Slack 适配器的 Socket Mode 事件、话题路由、Block Kit 和回复生命周期。
---

## 主要代码

| 文件                                       | 用途                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 核心：Socket Mode 事件、slash commands、Block Kit 操作、文件下载和消息发送。 |
| `src/adapters/slack/blocks.ts`             | Markdown → 原生 Slack block，以及 `<@userName>` → `<@U…>` 的 mention 解析。            |
| `src/adapters/slack/context.ts`            | 创建 Slack `ConversationResponder`；处理回复模式、工作状态和长消息。                   |
| `src/adapters/slack/session.ts`            | Slack 频道/话题会话 key 规则。                                                         |
| `src/adapters/slack/response-lifecycle.ts` | Slack 回复生命周期和流式更新。                                                         |
| `src/adapters/slack/tool-pack.ts`          | 注入运行时的 Slack 工具包。                                                            |
| `src/adapters/slack/tools/*`               | Slack 专用工具，例如附件和 Block Kit 支持。                                            |

## 事件来源

Slack 适配器主要处理：

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-sandbox`、`/pi-new`、`/pi-admin`、`/pi-extensions`、`/pi-auto-reply`——注册与路由都派生自 `src/commands/manifest.ts`，不过 Slack App manifest 本身仍需手动更新
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

代理编写标准 Markdown/GFM（即平台中立的响应源）。适配器通过 Slack 原生的 `markdown` block 渲染它，因此由 Slack 自己把 Markdown——粗体、斜体、删除线、行内与围栏代码、链接、嵌套列表和引用块——转换成富文本。旧式 Slack 风格的 `<url|label>` 链接会在渲染前转换为 `[label](url)`。Markdown 竖线表格会渲染为原生 Slack 表格 block。

Slack 适配器还支持：

- 顶层或话题回复模式
- 工作/assistant 状态
- Slack 原生流式 API（`chat.startStream` / `appendStream` / `stopStream`），以及基于编辑的进度更新
- 使用 Block Kit 渲染标题、段落、列表、代码围栏和表格
- 文件上传

Block Kit 输出遵循 Slack 限制：正文会在段落边界处拆分成最多 12,000 个字符的 `markdown` block，表格单元格在大约 2,000 个字符处截断，一条消息最多 50 个 block。对于非常大的结构化结果，请使用文件输出。

## Mention

响应源是平台中立的，因此模型使用提示词中 Users 表里的名称写作 `<@userName>`。适配器会在每条出站路径上——新消息、编辑和流式增量都一样——把它们转换成 Slack 原生的 `<@U…>` 形式，因为 Slack 只会对原始 user id 建立链接并发出通知。查找会不区分大小写地覆盖 `userName` 和 `displayName`，display name 绝不会遮蔽他人的 `userName`，已经是原生形式的 id 会原样通过，未知名称会被原样保留而不是猜测。跨两个流式增量被拆开的 mention 在该增量中保持未解析，并由最终的规范渲染完成解析。

## 附件

Slack 文件附件会以 `<timestamp>_<sanitized-name>` 的形式下载到该对话办公室的 `attachments/` 目录，然后带着办公室相对路径作为共享 mikan 附件元数据传给运行时。这与每个适配器使用的是同一个共享辅助函数；Slack 适配器只贡献下载调用。

## 停止行为

`stop` / `/stop` 首先停止当前话题会话。如果在频道顶层使用，适配器会根据当前运行的会话判断能否安全停止匹配的会话。
