---
title: Slack 接入
description: Slack adapter 的 Socket Mode 事件、thread routing、Block Kit 與回覆生命週期。
---

## 主要程式碼

| 檔案                                       | 用途                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 主體：Socket Mode events、slash commands、Block Kit actions、檔案下載、訊息送出。 |
| `src/adapters/slack/context.ts`            | 建立 Slack 版 `ConversationResponder`，處理 mrkdwn、回覆模式、working state、長訊息。       |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key 規則。                                                     |
| `src/adapters/slack/response-lifecycle.ts` | Slack 回覆生命週期與 streaming 更新。                                                       |
| `src/adapters/slack/tools/*`               | Slack 專用工具，例如附件與 Block Kit 支援。                                                 |

## 事件來源

Slack adapter 主要處理：

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-auto-reply`、`/pi-new` 等
- Block Kit actions
- assistant thread / status 相關 API

DM 會直接觸發 mikan。Channel 內的訊息通常需要 mention，或符合 auto-reply policy。

## Session 規則

Slack 有明確的 channel 與 thread 模型，所以 session key 也跟著分開：

| Slack 情境                | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

這讓 channel 對話與 thread 對話可以保有各自的 session context。

## 回覆與格式

Slack 使用 mrkdwn，不是一般 Markdown。Adapter 會在平台 formatting guide 中提醒 agent 使用：

- bold：`*text*`
- italic：`_text_`
- code：`` `code` ``
- block：三個 backtick
- link：`<url|text>`

Slack adapter 也支援：

- top-level 或 thread reply mode。
- working / assistant status。
- 更新既有回覆以呈現 streaming progress。
- Block Kit rendering。
- 檔案上傳。

## 附件

Slack file attachments 會下載到 workspace 的 conversation attachment 目錄，然後以 mikan 的共同 attachment metadata 傳給 runtime。

## Stop 行為

`stop` / `/stop` 會優先停止目前 thread session。若在 top-level channel 使用，adapter 會依目前 running sessions 判斷是否能安全停止對應 session。
