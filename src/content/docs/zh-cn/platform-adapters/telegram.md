---
title: Telegram 接入
description: Telegram adapter 的 long polling、消息更新、typing、文件下载与 session scope。
---

## 主要代码

| 文件                               | 用途                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `src/adapters/telegram/bot.ts`     | Telegram bot 主体：commands、message handler、attachments、file download、回复送出。 |
| `src/adapters/telegram/context.ts` | 创建 Telegram 版 `ConversationResponder`，处理 HTML mode、typing、message update。   |
| `src/adapters/telegram/html.ts`    | Escape / sanitize Telegram HTML，避免送出 Telegram 不支持的 markup。                 |
| `src/adapters/telegram/types.ts`   | Telegram adapter 专用类型。                                                          |

## 事件来源

Telegram adapter 主要处理：

- private chat 消息
- group / supergroup 消息
- commands：`/login`、`/session`、`/new`、`/stop`、`/model`
- reply message
- photo / document attachments

Private chat 会直接触发 mikan。Group 内需要 mention、command，或符合 auto-reply policy。

## Session 规则

Telegram 沒有 Slack 那种 thread_ts。mikan 用 reply 关系创建 scoped session：

| Telegram 场景           | session scope                       |
| ----------------------- | ----------------------------------- |
| Private chat            | chat session                        |
| Group top-level message | group chat session                  |
| Reply message           | 以 reply target 创建 scoped session |

这让同一个 group 裡的不同 reply chain 可以分开保存 context。

## 回复与格式

Telegram adapter 使用 HTML parse mode，不使用 Markdown。Adapter 会提醒 agent 使用：

- bold：`<b>text</b>`
- italic：`<i>text</i>`
- code：`<code>code</code>`
- pre：`<pre>code</pre>`
- link：`<a href="url">text</a>`

若 Telegram 报告 HTML parse error，adapter 会 fallback 成 escaped HTML 后再送出。

## 附件

Telegram adapter 支持 photo 与 document。文件会通过 Telegram file API 下载到 workspace 的 `attachments/`，再交给 runtime。

## Stop 行为

`/stop` 与文字 `stop` 会先于普通消息触发判断处理。若当前 scoped session 正在跑，会停止该 session；否则在 group 中会尝试找到唯一正在执行的 scoped session。
