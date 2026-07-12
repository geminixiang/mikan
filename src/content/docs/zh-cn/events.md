---
title: 事件
description: 通过工作区 events 目录触发代理的事件格式和处理流程。
---

## 事件类型

### 立即

框架一看到文件就会触发。适用于来自外部脚本或 webhook 的信号。

```json
{
  "type": "immediate",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "New GitHub issue opened"
}
```

### 单次

在指定时间触发一次。适用于提醒和未来回调。

```json
{
  "type": "one-shot",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Remind Mario about dentist",
  "at": "2025-12-15T09:00:00+01:00"
}
```

`at` 必须是包含 UTC 偏移量的 ISO 8601 时间戳。

### 周期性

按 cron 计划触发。文件会一直保留，直到被删除。

```json
{
  "type": "periodic",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Check inbox and summarize",
  "schedule": "0 9 * * 1-5",
  "timezone": "Asia/Taipei"
}
```

Cron 格式：`minute hour day-of-month month day-of-week`

常见计划：

- `0 9 * * *` — 每天 09:00
- `0 9 * * 1-5` — 工作日 09:00
- `0 0 1 * *` — 每月第一天午夜

## 路由字段

| 字段               | 说明                                                       |
| ------------------ | ---------------------------------------------------------- |
| `platform`         | 目标 bot 平台，例如 `slack`                                |
| `conversationId`   | 要发送到的频道或 DM ID                                     |
| `conversationKind` | `"shared"`（频道）或 `"direct"`（DM）                      |
| `userId`           | 请求此事件的平台用户 ID；在按用户模式下用于 vault/凭证路由 |

## 会话绑定

事件文件不包含 `sessionKey` 或话题目标。事件文本必须自成一体，因为计划/后台事件并不是创建它的实时聊天轮次的延续。

| 平台/事件来源                  | 可见的投递方式          | 会话 key                                      | 话题目标     |
| ------------------------------ | ----------------------- | --------------------------------------------- | ------------ |
| Slack 事件文件/工具            | 新的顶层锚点消息        | `<conversationId>:<anchor message ts>`        | 无           |
| Slack 直接 `ConversationEvent` | 提供的 `thread_ts` 优先 | 如果设置，则为 `<conversationId>:<thread_ts>` | 可选         |
| 其他平台事件                   | 平台适配器默认方式      | 平台适配器默认事件会话                        | 取决于适配器 |

对于 Slack 事件文件，mikan 会在事件触发时先创建一条顶层 Slack 消息。该消息时间戳成为锚点，运行使用固定会话 key `<conversationId>:<anchor message ts>`。

这使事件运行在频道中可见，并将其与持久顶层会话隔离。顶层频道历史记录仍可在 `log.jsonl` 中显式查询，但不会隐式复制到事件会话中。

## 话题目标

事件作为顶层消息投递，不应埋在旧话题或回复链中。

代理的 `event` 工具会自动填充路由字段。请使用该工具，而不要手写 JSON。

## 生命周期

- **立即**和**单次**文件会在成功投递后删除。
- 无效、过期、无法投递或队列溢出的立即/单次文件也会被删除；请检查日志或 Sentry 了解失败情况。
- **周期性**文件会保留。删除文件即可取消事件。
- 最多可同时排队 5 个事件。额外的立即/单次文件会按上述方式丢弃。

## 静默回复

对于没有内容可报告的周期性事件，请准确回复 `[SILENT]`。框架会删除状态消息且不向平台发帖，从而避免刷屏。

## 防抖

编写发送立即事件的脚本（如电子邮件监视器或 webhook 处理程序）时，请进行防抖。在一个时间窗口内收集事件并发送一个摘要事件，而不是每个项目发送一个事件。
