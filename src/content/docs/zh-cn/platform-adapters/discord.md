---
title: Discord 接入
description: Discord adapter 的事件接收、session scope、slash commands 与消息回复流程。
---

## 主要代码

| 文件                              | 用途                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/adapters/discord/bot.ts`     | Discord bot 主体：message events、slash commands、attachments、channel lookup、回复送出。  |
| `src/adapters/discord/context.ts` | 创建 Discord 版 `ConversationResponder`，处理 Markdown、typing indicator、message update。 |
| `src/adapters/discord/types.ts`   | Discord adapter 专用类型。                                                                 |

## 事件来源

Discord adapter 主要处理：

- `messageCreate`
- slash commands：`login`、`session`、`new`、`stop`、`model`、`sandbox`
- DM、guild channel、thread channel 消息
- message attachments

DM 会直接触发 mikan。Guild channel 内通常需要 mention、thread reply，或符合 auto-reply policy。

## Session 规则

Discord adapter 使用通用的 `resolveChatSessionKey()` 计算 session：

| Discord 场景                    | session scope                       |
| ------------------------------- | ----------------------------------- |
| DM                              | DM conversation                     |
| Guild channel top-level message | channel conversation                |
| Thread channel 或 reply         | scoped session                      |
| Slash command                   | 以 interaction context 创建 session |

这让 Discord thread 与一般 channel 对话不会互相污染 context。

## 回复与格式

Discord response context 会处理：

- Discord Markdown。
- typing indicator。
- 首次回复与后续 message update。
- reply target，也就是回复到原消息。
- 长消息切分。

Slash command 在 guild 中通常使用 ephemeral response；DM 中则直接回复使用者。

## 附件

Discord attachments 会下载到 workspace 的 `attachments/`，档名会先做简单 sanitize，再传给 runtime。

## Stop 行为

`stop` / `/stop` 会在 trigger gate 前处理，避免 stop 指令被 auto-reply policy 挡掉。Adapter 会依 session key 与当前 running sessions 找出要停止的 session。
