---
title: 事件
description: 透過 workspace events 目錄觸發 agent 的事件格式與處理流程。
---

## 事件類型

### 立即

harness 一看到檔案就會觸發。適合從外部腳本或 webhook 發送訊號。

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

### 單次

在指定時間觸發一次。適合提醒事項與未來的 callback。

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

`at` 必須是含 UTC offset 的 ISO 8601 時間戳記。

### 週期性

依 cron 排程觸發。會持續存在，直到檔案被刪除。

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

常見排程：

- `0 9 * * *` — 每天 09:00
- `0 9 * * 1-5` — 平日 09:00
- `0 0 1 * *` — 每月第一天午夜

## 路由欄位

| 欄位               | 說明                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `platform`         | 目標 bot 平台（例如 `slack`）                                           |
| `conversationId`   | 要發送到的頻道或 DM ID                                                  |
| `conversationKind` | `"shared"`（頻道）或 `"direct"`（DM）                                   |
| `userId`           | 請求此事件的平台使用者 ID；在 per-user 模式中用於 vault/credential 路由 |

## Session 綁定

事件檔案不帶有 `sessionKey` 或 thread 目標。事件文字必須自給自足，因為排程/背景事件不是建立它的即時聊天回合的延續。

| 平台/事件來源           | 可見的送達方式          | Session key                                 | Thread 目標     |
| ----------------------- | ----------------------- | ------------------------------------------- | --------------- |
| Slack event file/tool   | 新的頂層錨點訊息        | `<conversationId>:<anchor message ts>`      | 無              |
| Slack direct `BotEvent` | 提供的 `thread_ts` 優先 | 若有設定則為 `<conversationId>:<thread_ts>` | 可選            |
| 其他平台事件            | 平台 adapter 預設       | 平台 adapter 預設事件 session               | 依 adapter 而定 |

對 Slack 事件檔案來說，事件觸發時會先主動建立一則頂層 Slack 訊息。該訊息時間戳會成為錨點，而該次執行會使用固定的 session key `<conversationId>:<anchor message ts>`。

這會讓事件執行在頻道中可見，並將它們與持久的頂層 session 隔離。頂層頻道歷史仍可在 `log.jsonl` 中供明確查詢，但不會被隱式複製到事件 session。

## Thread 目標

事件會以頂層訊息送達。不應把它們埋在歷史 thread 或回覆串中。

agent 可用的 `event` tool 會自動填入路由欄位。請使用它，不要手寫 JSON。

## 生命週期

- **立即**與**單次**檔案會在事件觸發後自動刪除。
- **週期性**檔案會持續存在。刪除檔案即可取消。
- 一次最多可排入 5 個事件。

## 靜默回應

對於沒有內容可回報的週期性事件，請精確回應 `[SILENT]`。harness 會刪除狀態訊息，且不向平台發文，以避免頻道洗版。

## Debouncing

撰寫會送出立即事件的腳本（email watchers、webhook handlers）時，務必做 debounce。在一段時間窗內收集事件，並送出一個摘要事件，而不是每個項目送出一個事件。
