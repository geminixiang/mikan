---
title: Slack 接入
description: Slack adapter 的 Socket Mode 事件、thread routing、Block Kit 與回覆生命週期。
---

## 主要程式碼

| 檔案                                       | 用途                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 主體：Socket Mode events、slash commands、Block Kit actions、檔案下載、訊息送出。 |
| `src/adapters/slack/blocks.ts`             | Markdown → 原生 Slack blocks，以及 `<@userName>` → `<@U…>` 的 mention 解析。                |
| `src/adapters/slack/context.ts`            | 建立 Slack `ConversationResponder`；處理回覆模式、working state 與長訊息。                  |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key 規則。                                                     |
| `src/adapters/slack/response-lifecycle.ts` | Slack 回覆生命週期與 streaming 更新。                                                       |
| `src/adapters/slack/tool-pack.ts`          | 注入 runtime 的 Slack tool pack。                                                           |
| `src/adapters/slack/tools/*`               | Slack 專用工具，例如附件與 Block Kit 支援。                                                 |

## 事件來源

Slack adapter 主要處理：

- `app_mention`
- `message`
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

Agent 寫的是標準 Markdown/GFM（也就是平台中立的 response source）。Adapter 透過 Slack 原生的 `markdown` block 來 render，因此是 Slack 自己把 Markdown——粗體、斜體、刪除線、行內與 fenced code、連結、巢狀清單與 blockquote——轉成 rich text。舊式 Slack 風格的 `<url|label>` 連結會在 render 前轉成 `[label](url)`。Markdown 的 pipe table 會 render 成原生 Slack table block。

Slack adapter 也支援：

- top-level 或 thread reply mode
- working / assistant status
- Slack 原生的 streaming API（`chat.startStream` / `appendStream` / `stopStream`），以及以編輯為基礎的進度更新
- 對 headings、paragraphs、lists、code fences 與 tables 進行 Block Kit rendering
- 檔案上傳

Block Kit 輸出遵循 Slack 限制：散文會在段落邊界切成最多 12,000 字元的 `markdown` block、table cells 約在 2,000 字元處截斷，單一訊息上限為 50 個 blocks。非常大的結構化結果請使用檔案輸出。

## Mention

Response source 是平台中立的，因此模型會使用 prompt 中 Users 表格裡的名稱寫成 `<@userName>`。Adapter 會在每一條對外路徑上——新訊息、編輯與 stream delta 都一樣——把它們轉成 Slack 原生的 `<@U…>` 形式，因為 Slack 只會對原始 user id 建立連結與發送通知。查詢會不分大小寫地涵蓋 `userName` 與 `displayName`，display name 絕不會蓋掉別人的 `userName`，已經是原生 id 的會原樣通過，而查不到的名稱會照原文保留，不會用猜的。橫跨兩個 stream delta 的 mention 在該 delta 中會維持未解析，並由最終的正規 render 解析。

## 附件

Slack file attachments 會以 `<timestamp>_<sanitized-name>` 下載到該對話 office 的 `attachments/` 目錄，然後以共用的 mikan attachment metadata、搭配相對於 office 的路徑傳給 runtime。這和每個 adapter 使用的是同一個共用 helper；Slack adapter 只負責那個下載呼叫。

## Stop 行為

`stop` / `/stop` 會先停止目前 thread session。若在 channel top level 使用，adapter 會依目前執行中的 sessions 判斷是否能安全停止相符的 session。
