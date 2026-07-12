---
title: Slack 接入
description: Slack adapter 的 Socket Mode 事件、thread routing、Block Kit 與回覆生命週期。
---

## 主要程式碼

| 檔案                                       | 用途                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 主體：Socket Mode events、slash commands、Block Kit actions、檔案下載、訊息送出。 |
| `src/adapters/slack/context.ts`            | 建立 Slack `ConversationResponder`；處理 mrkdwn、回覆模式、working state 與長訊息。         |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key 規則。                                                     |
| `src/adapters/slack/response-lifecycle.ts` | Slack 回覆生命週期與 streaming 更新。                                                       |
| `src/adapters/slack/tools/*`               | Slack 專用工具，例如附件與 Block Kit 支援。                                                 |

## 事件來源

Slack adapter 主要處理：

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-auto-reply`、`/pi-new` 等
- Block Kit actions
- assistant thread / status APIs

DM 會直接觸發 mikan。共享頻道訊息需要 mention、互動或符合 auto-reply policy。頻道 thread 中未 mention 的一般人類回覆會被記錄，但不會觸發執行；thread session 隔離不會繞過 trigger policy。

## Session 規則

Slack 有明確的 channel 與 thread 模型，因此 session keys 會據此分離：

| Slack 情境                | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

這讓 channel 對話與 thread 對話保有各自的 session contexts。

## 回覆與格式

Slack 使用 mrkdwn，而非一般 Markdown。Adapter 的平台 formatting guide 會要求 agent 使用：

- bold：`*text*`
- italic：`_text_`
- code：`` `code` ``
- block：三個 backticks
- link：`<url|text>`

Slack adapter 也支援：

- top-level 或 thread reply mode
- working / assistant status
- 更新既有回覆以顯示 streaming progress
- 對 headings、paragraphs、lists、code fences 與 tables 進行 Block Kit rendering
- 檔案上傳

Block Kit 輸出遵循 Slack 限制：sections 約在 3,000 字元處切分、table cells 約在 2,000 字元處切分，單一訊息上限為 50 個 blocks。超出 block 上限的內容不會 render，因此非常大的結構化結果請使用檔案輸出。

## 附件

Slack file attachments 會下載到 workspace 的 conversation attachment 目錄，然後以共用的 mikan attachment metadata 傳給 runtime。

## Stop 行為

`stop` / `/stop` 會先停止目前 thread session。若在 channel top level 使用，adapter 會依目前執行中的 sessions 判斷是否能安全停止相符的 session。
