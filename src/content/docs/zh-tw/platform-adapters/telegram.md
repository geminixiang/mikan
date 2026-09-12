---
title: Telegram 接入
description: 設定 BotFather privacy、long polling、reply-scoped sessions、commands、files 與 HTML responses。
---

## 設定

1. 使用 [@BotFather](https://t.me/BotFather) 建立 bot 並複製 token。
2. 除非其他明確整合需要一般群組訊息，否則保留 BotFather privacy mode。Privacy mode 限制群組訊息送達；使用 `/setprivacy` 停用它也不會讓 mikan 回覆未被明確指向的訊息。
3. 將 bot 加入每個群組，且僅授予讀取與傳送訊息或檔案所需的 group/admin permissions。
4. 設定 token 並啟動 mikan：

```bash
export TELEGRAM_BOT_TOKEN="..."
mikan /path/to/workspace
```

mikan 使用 long polling；不需要公開 Telegram webhook。

## 事件來源與觸發條件

Adapter 處理：

- private、group 與 supergroup 訊息
- `/login`、`/session`、`/new`、`/stop`、`/model` 與 `/sandbox`——指令選單是透過 `setMyCommands` 從 `src/adapters/commands/manifest.ts` 註冊的，因此絕不會與共用清單脫節
- replies、photos 與 documents

私人訊息會直接觸發。群組訊息需要指向 bot 的 command、mention 或支援的 reply context。Telegram 必須先將訊息送達 bot；擴大送達範圍不會繞過明確觸發條件。

## Session 規則

Telegram 沒有 Slack 形式的 `thread_ts`。mikan 從直接 reply 關係推導 scope：

| 情境                           | Session identity                 |
| ------------------------------ | -------------------------------- |
| Private chat                   | chat ID                          |
| 觸發的 group top-level message | `<chatId>:<messageId>`           |
| Reply                          | `<chatId>:<referencedMessageId>` |

因此 nested replies 會依 referenced message IDs，而非平台提供的持久 thread root。Telegram forum-topic `message_thread_id` 目前不是個別記錄的 session dimension。

## 回覆與附件

回應使用 Telegram HTML mode。支援的格式包括 `<b>`、`<i>`、`<code>`、`<pre>` 與 `<a href="...">`。若 Telegram 拒絕產生的 markup，mikan 會使用 escaped HTML 重試。Responder 也支援 typing status、message edits、reply targets 與檔案上傳。

收到的 photos 與 documents 會透過 Telegram file API，以其他 adapter 共用的同一個 helper，用 `<timestamp>_<sanitized-name>` 下載到該對話 office 的 `attachments/` 目錄。Voice、audio、video、stickers 與 polls 等其他 media types 不會當成同等的 inbound attachments 處理。

## Stop 行為

`/stop` 與文字 `stop` 會在一般 trigger decision 前處理。mikan 會先以目前 scoped session 為目標；在群組中，若只有一個目前執行中的 scoped session 且選擇明確，則可 fallback 至該 session。
