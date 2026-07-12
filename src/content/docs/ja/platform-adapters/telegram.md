---
title: Telegram 接続
description: BotFather privacy、long polling、reply-scoped sessions、commands、files、HTML responses を設定します。
---

## セットアップ

1. [@BotFather](https://t.me/BotFather) で bot を作成し、token をコピーします。
2. bot が通常の group messages を受信する必要があるか判断します。BotFather privacy mode では通常、group での配信は commands、mentions、bot への replies に制限されます。group 全体の auto-reply rules で広範な受信が必要な場合にのみ、`/setprivacy` で privacy mode を無効にしてください。
3. bot を各 group に追加し、messages または files の読み取りと送信に必要な group/admin permissions だけを付与します。
4. token を設定し、mikan を起動します：

```bash
export TELEGRAM_BOT_TOKEN="..."
mikan /path/to/workspace
```

mikan は long polling を使用します。公開 Telegram webhook は不要です。

## イベントソースと trigger

Adapter は次を処理します：

- private、group、supergroup messages
- `/login`、`/session`、`/new`、`/stop`、`/model`、`/sandbox`
- replies、photos、documents

Private messages は直接起動します。Group messages には command、mention、reply context、または一致する auto-reply policy が必要です。Telegram が最初に message を bot へ配信する必要があります。privacy mode により、auto-reply rule が通常の group traffic を受信できない場合があります。

## Session ルール

Telegram には Slack 形式の `thread_ts` がありません。mikan は直近の reply 関係から scope を導出します：

| 状況                                   | Session identity                 |
| -------------------------------------- | -------------------------------- |
| Private chat                           | chat ID                          |
| Trigger された group top-level message | `<chatId>:<messageId>`           |
| Reply                                  | `<chatId>:<referencedMessageId>` |

そのため nested replies は、プラットフォームが提供する永続的な thread root ではなく、参照された message IDs に従います。Telegram forum-topic の `message_thread_id` は現在、別の session dimension として文書化されていません。

## 返信と添付ファイル

Responses は Telegram HTML mode を使用します。対応する形式には `<b>`、`<i>`、`<code>`、`<pre>`、`<a href="...">` があります。生成された markup を Telegram が拒否した場合、mikan は escaped HTML で再試行します。Responder は typing status、message edits、reply targets、file uploads もサポートします。

受信した photos と documents は Telegram file API を通じて conversation の `attachments/` directory にダウンロードされます。voice、audio、video、stickers、polls などの他の media types は、同等の inbound attachments として処理されません。

## Stop 動作

`/stop` とテキスト `stop` は通常の trigger 判定より先に処理されます。mikan はまず現在の scoped session を対象とし、group では対象が明確な場合に限り、唯一実行中の scoped session へ fallback できます。
