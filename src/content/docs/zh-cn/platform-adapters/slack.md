---
title: Slack 接入
description: Slack adapter 的 Socket Mode 事件、thread routing、Block Kit 与回复生命周期。
---

## 主要代码

| 文件                                       | 用途                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 主体：Socket Mode events、slash commands、Block Kit actions、文件下载、消息送出。 |
| `src/adapters/slack/context.ts`            | 创建 Slack 版 `ConversationResponder`，处理 mrkdwn、回复模式、working state、长消息。       |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key 规则。                                                     |
| `src/adapters/slack/response-lifecycle.ts` | Slack 回复生命周期与 streaming 更新。                                                       |
| `src/adapters/slack/tools/*`               | Slack 专用工具，例如附件与 Block Kit 支持。                                                 |

## 事件来源

Slack adapter 主要处理：

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-auto-reply`、`/pi-new` 等
- Block Kit actions
- assistant thread / status 相关 API

DM 会直接触发 mikan。Channel 内的消息通常需要 mention，或符合 auto-reply policy。

## Session 规则

Slack 有明确的 channel 与 thread 模型，所以 session key 也跟著分开：

| Slack 场景                | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

这让 channel 对话与 thread 对话可以保有各自的 session context。

## 回复与格式

Slack 使用 mrkdwn，不是普通 Markdown。Adapter 会在平台 formatting guide 中提醒 agent 使用：

- bold：`*text*`
- italic：`_text_`
- code：`` `code` ``
- block：三个 backtick
- link：`<url|text>`

Slack adapter 也支持：

- top-level 或 thread reply mode。
- working / assistant status。
- 更新现有回复以呈现 streaming progress。
- Block Kit rendering。
- 文件上传。

## 附件

Slack file attachments 会下载到 workspace 的 conversation attachment 目录，然后以 mikan 的通用 attachment metadata 传给 runtime。

## Stop 行为

`stop` / `/stop` 会优先停止当前 thread session。若在 top-level channel 使用，adapter 会按当前 running sessions 判断能否安全停止对应 session。
