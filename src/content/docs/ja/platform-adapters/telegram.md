---
title: Telegram 接続
description: Telegram adapter の long polling、メッセージ更新、typing、ファイルダウンロード、session scope。
---

## 主要コード

| ファイル                           | 用途                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/adapters/telegram/bot.ts`     | Telegram bot 本体：commands、message handler、attachments、file download、返信送信。     |
| `src/adapters/telegram/context.ts` | Telegram 版 `PlatformResponder` を作成し、HTML mode、typing、message update を処理。     |
| `src/adapters/telegram/html.ts`    | Telegram HTML を escape / sanitize し、Telegram が未対応の markup を送らないようにする。 |
| `src/adapters/telegram/types.ts`   | Telegram adapter 専用型。                                                                |

## イベントソース

Telegram adapter は主に次を処理します。

- private chat メッセージ
- group / supergroup メッセージ
- commands：`/login`、`/session`、`/new`、`/stop`、`/model`
- reply message
- photo / document attachments

Private chat は mikan を直接起動します。Group 内では mention、command、または auto-reply policy への一致が必要です。

## Session ルール

Telegram には Slack のような thread_ts がありません。mikan は reply 関係を使って scoped session を作成します。

| Telegram 状況           | session scope                               |
| ----------------------- | ------------------------------------------- |
| Private chat            | chat session                                |
| Group top-level message | group chat session                          |
| Reply message           | reply target を基準に scoped session を作成 |

これにより同じ group 内の異なる reply chain が別々に context を保持できます。

## 返信と形式

Telegram adapter は Markdown ではなく HTML parse mode を使います。Adapter は agent に次の使用を促します。

- bold：`<b>text</b>`
- italic：`<i>text</i>`
- code：`<code>code</code>`
- pre：`<pre>code</pre>`
- link：`<a href="url">text</a>`

Telegram が HTML parse error を返した場合、adapter は escaped HTML に fallback して再送信します。

## 添付ファイル

Telegram adapter は photo と document をサポートします。ファイルは Telegram file API 経由で workspace の `attachments/` にダウンロードされ、runtime に渡されます。

## Stop 動作

`/stop` と文字列 `stop` は通常メッセージの trigger 判定より先に処理されます。現在の scoped session が実行中ならその session を停止し、そうでない場合は group 内で唯一実行中の scoped session を探します。
