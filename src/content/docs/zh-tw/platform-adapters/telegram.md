---
title: Telegram 接入
---

# Telegram 接入

Telegram adapter 位於 `src/adapters/telegram/*`。它使用 grammy long polling 接收訊息，並用 Telegram Bot API 回覆、更新訊息、顯示 typing、下載檔案。

## 主要程式碼

| 檔案                               | 用途                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `src/adapters/telegram/bot.ts`     | Telegram bot 主體：commands、message handler、attachments、file download、回覆送出。 |
| `src/adapters/telegram/context.ts` | 建立 Telegram 版 `ChatResponseContext`，處理 HTML mode、typing、message update。     |
| `src/adapters/telegram/html.ts`    | Escape / sanitize Telegram HTML，避免送出 Telegram 不支援的 markup。                 |
| `src/adapters/telegram/types.ts`   | Telegram adapter 專用型別。                                                          |

## 事件來源

Telegram adapter 主要處理：

- private chat 訊息
- group / supergroup 訊息
- commands：`/login`、`/session`、`/new`、`/stop`、`/model`
- reply message
- photo / document attachments

Private chat 會直接觸發 mikan。Group 內需要 mention、command，或符合 auto-reply policy。

## Session 規則

Telegram 沒有 Slack 那種 thread_ts。mikan 用 reply 關係建立 scoped session：

| Telegram 情境           | session scope                       |
| ----------------------- | ----------------------------------- |
| Private chat            | chat session                        |
| Group top-level message | group chat session                  |
| Reply message           | 以 reply target 建立 scoped session |

這讓同一個 group 裡的不同 reply chain 可以分開保存 context。

## 回覆與格式

Telegram adapter 使用 HTML parse mode，不使用 Markdown。Adapter 會提醒 agent 使用：

- bold：`<b>text</b>`
- italic：`<i>text</i>`
- code：`<code>code</code>`
- pre：`<pre>code</pre>`
- link：`<a href="url">text</a>`

若 Telegram 回報 HTML parse error，adapter 會 fallback 成 escaped HTML 後再送出。

## 附件

Telegram adapter 支援 photo 與 document。檔案會透過 Telegram file API 下載到 workspace 的 `attachments/`，再交給 runtime。

## Stop 行為

`/stop` 與文字 `stop` 會先於一般訊息觸發判斷處理。若目前 scoped session 正在跑，會停止該 session；否則在 group 中會嘗試找到唯一正在執行的 scoped session。
