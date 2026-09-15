---
title: 事件
description: 透過 event tool 管理的排程 agent 執行之事件格式與處理流程。
---

## 事件檔案放在哪裡

事件紀錄存放在 host 端的 `<state-dir>/conversations/<office-key>/events/`，不在 workspace 內，也不會掛載進任何 sandbox。agent 只能透過 `event` tool 管理事件，而且只能接觸目前 Office 自己的紀錄：其他 Office 的檔名會回報「not found」，`scope=all` 會被拒絕，`create` 不會覆蓋既有檔案。刪除紀錄會立即取消對應的 timer 或 cron。跨 Office 排程無法透過此工具完成，需要 Office policy 中定義的明確授權。

從舊的 workspace `events/` 匯流排升級時，請先停止 daemon 再執行 `mikan office migrate-events`；沒有明確 `platform`、或對不上已註冊 Office 的紀錄會被列出並保留原地。

## 事件類型

### 立即

紀錄一建立就會執行，例如 agent 在回合結束時替自己排的接續工作。

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

`at` 必須是以 `Z` 或明確的 `±HH:MM` UTC offset 結尾的 ISO 8601 時間戳記。

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

每個事件檔案都必須有 `type`、`conversationId` 與 `text`；其餘為選填，而各類型專屬的欄位（`at`、`schedule` + `timezone`）在該類型中則是必填。schema 由 `src/events/index.ts` 擁有——每個讀取者與寫入者都會經過它的 parser 與 builder。

| 欄位               | 說明                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `platform`         | 目標 bot 平台（例如 `slack`）。若省略，當兩個平台共用同一個 raw conversation id 時，這個檔案就會有歧義 |
| `conversationId`   | 要發送到的原始平台頻道或 DM ID——不是 office key。`channelId` 仍被接受為唯讀的 legacy 別名              |
| `conversationKind` | `"shared"`（頻道）或 `"direct"`（DM）                                                                  |
| `userId`           | 請求此事件的平台使用者 ID；在 per-user 模式中用於 vault/credential 路由                                |

## Session 綁定

事件檔案不帶有 `sessionKey` 或 thread 目標。事件文字必須自給自足，因為排程/背景事件不是建立它的即時聊天回合的延續。

| 平台/事件來源                    | 可見的送達方式          | Session key                                 | Thread 目標     |
| -------------------------------- | ----------------------- | ------------------------------------------- | --------------- |
| Slack event file/tool            | 新的頂層錨點訊息        | `<conversationId>:<anchor message ts>`      | 無              |
| Slack direct `ConversationEvent` | 提供的 `thread_ts` 優先 | 若有設定則為 `<conversationId>:<thread_ts>` | 可選            |
| 其他平台事件                     | 平台 adapter 預設       | 平台 adapter 預設事件 session               | 依 adapter 而定 |

對 Slack 事件檔案來說，事件觸發時會先主動建立一則頂層 Slack 訊息。該訊息時間戳會成為錨點，而該次執行會使用固定的 session key `<conversationId>:<anchor message ts>`。

這會讓事件執行在頻道中可見，並將它們與持久的頂層 session 隔離。頂層頻道歷史仍可在 `log.jsonl` 中供明確查詢，但不會被隱式複製到事件 session。

## Thread 目標

事件會以頂層訊息送達。不應把它們埋在歷史 thread 或回覆串中。

agent 可用的 `event` tool 會自動填入路由欄位。請使用它，不要手寫 JSON。

## 生命週期

- **立即**與**單次**檔案會在成功送達後刪除。
- 無效、過期、無法送達或 queue overflow 的立即／單次檔案也會刪除；請查看 logs 或 Sentry 瞭解失敗原因。
- **週期性**檔案會持續存在。刪除檔案即可取消事件。
- 一次最多可排入 5 個事件。超出的立即／單次檔案會如上所述遭到丟棄。

## 靜默回應

對於沒有內容可回報的週期性事件，請精確回應 `[SILENT]`。harness 會刪除狀態訊息，且不向平台發文，以避免頻道洗版。
