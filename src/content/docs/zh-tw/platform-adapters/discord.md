---
title: Discord 接入
description: Discord adapter 的事件接收、session scope、slash commands 與訊息回覆流程。
---

## 主要程式碼

| 檔案                              | 用途                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/adapters/discord/bot.ts`     | Discord bot 主體：message events、slash commands、attachments、channel lookup、回覆送出。 |
| `src/adapters/discord/context.ts` | 建立 Discord 版 `ChatResponseContext`，處理 Markdown、typing indicator、message update。  |
| `src/adapters/discord/types.ts`   | Discord adapter 專用型別。                                                                |

## 事件來源

Discord adapter 主要處理：

- `messageCreate`
- slash commands：`login`、`session`、`new`、`stop`、`model`、`sandbox`
- DM、guild channel、thread channel 訊息
- message attachments

DM 會直接觸發 mikan。Guild channel 內通常需要 mention、thread reply，或符合 auto-reply policy。

## Session 規則

Discord adapter 使用共同的 `resolveChatSessionKey()` 計算 session：

| Discord 情境                    | session scope                       |
| ------------------------------- | ----------------------------------- |
| DM                              | DM conversation                     |
| Guild channel top-level message | channel conversation                |
| Thread channel 或 reply         | scoped session                      |
| Slash command                   | 以 interaction context 建立 session |

這讓 Discord thread 與一般 channel 對話不會互相污染 context。

## 回覆與格式

Discord response context 會處理：

- Discord Markdown。
- typing indicator。
- 初次回覆與後續 message update。
- reply target，也就是回覆到原訊息。
- 長訊息切割。

Slash command 在 guild 中通常使用 ephemeral response；DM 中則直接回覆使用者。

## 附件

Discord attachments 會下載到 workspace 的 `attachments/`，檔名會先做簡單 sanitize，再傳給 runtime。

## Stop 行為

`stop` / `/stop` 會在 trigger gate 前處理，避免 stop 指令被 auto-reply policy 擋掉。Adapter 會依 session key 與目前 running sessions 找出要停止的 session。
