---
title: Slack 接続
description: Slack adapter の Socket Mode イベント、thread routing、Block Kit、返信ライフサイクル。
---

## 主要コード

| ファイル                                   | 用途                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 本体：Socket Mode events、slash commands、Block Kit actions、ファイルダウンロード、メッセージ送信。 |
| `src/adapters/slack/context.ts`            | Slack 版 `ChatResponseContext` を作成し、mrkdwn、返信モード、working state、長文メッセージを処理。            |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key のルール。                                                                   |
| `src/adapters/slack/response-lifecycle.ts` | Slack 返信ライフサイクルと streaming 更新。                                                                   |
| `src/adapters/slack/tools/*`               | 添付ファイルや Block Kit サポートなどの Slack 専用ツール。                                                    |

## イベントソース

Slack adapter は主に次を処理します。

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-auto-reply`、`/pi-new` など
- Block Kit actions
- assistant thread / status 関連 API

DM は mikan を直接起動します。Channel 内のメッセージは通常 mention が必要です。あるいは auto-reply policy に一致する必要があります。

## Session ルール

Slack には明確な channel と thread モデルがあるため、session key もそれに合わせて分かれます。

| Slack 状況                | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

これにより channel の会話と thread の会話は、それぞれ独立した session context を保持できます。

## 返信と形式

Slack は通常の Markdown ではなく mrkdwn を使います。Adapter は platform formatting guide で agent に次の使用を促します。

- bold：`*text*`
- italic：`_text_`
- code：`` `code` ``
- block：3 つの backtick
- link：`<url|text>`

Slack adapter は次もサポートします。

- top-level または thread reply mode。
- working / assistant status。
- streaming progress を表示するための既存返信更新。
- Block Kit rendering。
- ファイルアップロード。

## 添付ファイル

Slack file attachments は workspace の conversation attachment ディレクトリにダウンロードされ、その後 mikan の共通 attachment metadata として runtime に渡されます。

## Stop 動作

`stop` / `/stop` は、現在の thread session を優先して停止します。top-level channel で使われた場合、adapter は現在の running sessions から、対応する session を安全に停止できるか判断します。
