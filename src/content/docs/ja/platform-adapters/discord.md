---
title: Discord 接続
description: Discord adapter のイベント受信、session scope、slash commands、メッセージ返信フロー。
---

## 主要コード

| ファイル                          | 用途                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/adapters/discord/bot.ts`     | Discord bot 本体：message events、slash commands、attachments、channel lookup、返信送信。      |
| `src/adapters/discord/context.ts` | Discord 版 `ChatResponseContext` を作成し、Markdown、typing indicator、message update を処理。 |
| `src/adapters/discord/types.ts`   | Discord adapter 専用型。                                                                       |

## イベントソース

Discord adapter は主に次を処理します。

- `messageCreate`
- slash commands：`login`、`session`、`new`、`stop`、`model`、`sandbox`
- DM、guild channel、thread channel メッセージ
- message attachments

DM は mikan を直接起動します。Guild channel 内では通常 mention、thread reply、または auto-reply policy への一致が必要です。

## Session ルール

Discord adapter は共通の `resolveChatSessionKey()` で session を計算します。

| Discord 状況                    | session scope                           |
| ------------------------------- | --------------------------------------- |
| DM                              | DM conversation                         |
| Guild channel top-level message | channel conversation                    |
| Thread channel または reply     | scoped session                          |
| Slash command                   | interaction context から session を作成 |

これにより Discord thread と通常の channel 会話が context を混在させません。

## 返信と形式

Discord response context は次を処理します。

- Discord Markdown。
- typing indicator。
- 初回返信と後続の message update。
- reply target、つまり元メッセージへの返信。
- 長文メッセージ分割。

Slash command は guild 内では通常 ephemeral response を使い、DM ではユーザーへ直接返信します。

## 添付ファイル

Discord attachments は workspace の `attachments/` にダウンロードされます。ファイル名は簡単に sanitize されてから runtime に渡されます。

## Stop 動作

`stop` / `/stop` は trigger gate の前に処理され、stop 指令が auto-reply policy によって遮られないようにします。Adapter は session key と現在の running sessions から停止対象の session を見つけます。
