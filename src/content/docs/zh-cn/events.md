---
title: 事件
description: 透过 workspace events 目录触发 agent 的事件格式与处理流程。
---

## 事件类型

### 立即

harness 一看到档案就会触发。适合从外部脚本或 webhook 发送讯号。

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

在指定时间触发一次。适合提醒事项与未来的 callback。

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

`at` 必须是含 UTC offset 的 ISO 8601 时间戳记。

### 周期性

依 cron 排程触发。会持续存在，直到档案被删除。

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

常见排程：

- `0 9 * * *` — 每天 09:00
- `0 9 * * 1-5` — 平日 09:00
- `0 0 1 * *` — 每月第一天午夜

## 路由栏位

| 栏位               | 说明                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `platform`         | 目标 bot 平台（例如 `slack`）                                           |
| `conversationId`   | 要发送到的频道或 DM ID                                                  |
| `conversationKind` | `"shared"`（频道）或 `"direct"`（DM）                                   |
| `userId`           | 请求此事件的平台使用者 ID；在 per-user 模式中用于 vault/credential 路由 |

## Session 绑定

事件档案不带有 `sessionKey` 或 thread 目标。事件文字必须自给自足，因为排程/背景事件不是建立它的即时聊天回合的延续。

| 平台/事件来源           | 可见的送达方式          | Session key                                 | Thread 目标     |
| ----------------------- | ----------------------- | ------------------------------------------- | --------------- |
| Slack event file/tool   | 新的顶层锚点讯息        | `<conversationId>:<anchor message ts>`      | 无              |
| Slack direct `BotEvent` | 提供的 `thread_ts` 优先 | 若有设定则为 `<conversationId>:<thread_ts>` | 可选            |
| 其他平台事件            | 平台 adapter 预设       | 平台 adapter 预设事件 session               | 依 adapter 而定 |

对 Slack 事件档案来说，事件触发时会先主动建立一则顶层 Slack 讯息。该讯息时间戳会成为锚点，而该次执行会使用固定的 session key `<conversationId>:<anchor message ts>`。

这会让事件执行在频道中可见，并将它们与持久的顶层 session 隔离。顶层频道历史仍可在 `log.jsonl` 中供明确查询，但不会被隐式复制到事件 session。

## Thread 目标

事件会以顶层讯息送达。不应把它们埋在历史 thread 或回覆串中。

agent 可用的 `event` tool 会自动填入路由栏位。请使用它，不要手写 JSON。

## 生命周期

- **立即**与**单次**档案会在事件触发后自动删除。
- **周期性**档案会持续存在。删除档案即可取消。
- 一次最多可排入 5 个事件。

## 静默回应

对于没有内容可回报的周期性事件，请精确回应 `[SILENT]`。harness 会删除状态讯息，且不向平台发文，以避免频道洗版。

## Debouncing

撰写会送出立即事件的脚本（email watchers、webhook handlers）时，务必做 debounce。在一段时间窗内收集事件，并送出一个摘要事件，而不是每个项目送出一个事件。
