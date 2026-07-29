---
title: Slack 接続
description: Slack adapter の Socket Mode イベント、thread routing、Block Kit、返信ライフサイクル。
---

## 主要コード

| ファイル                                   | 用途                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/adapters/slack/bot.ts`                | Slack bot 本体：Socket Mode events、slash commands、Block Kit actions、ファイルダウンロード、メッセージ送信。 |
| `src/adapters/slack/blocks.ts`             | Markdown → ネイティブ Slack blocks、および `<@userName>` → `<@U…>` の mention 解決。                          |
| `src/adapters/slack/context.ts`            | Slack 版 `ConversationResponder` を作成し、返信モード、working state、長文メッセージを処理。                  |
| `src/adapters/slack/session.ts`            | Slack channel/thread session key のルール。                                                                   |
| `src/adapters/slack/response-lifecycle.ts` | Slack 返信ライフサイクルと streaming 更新。                                                                   |
| `src/adapters/slack/tool-pack.ts`          | runtime に注入される Slack tool pack。                                                                        |
| `src/adapters/slack/tools/*`               | 添付ファイルや Block Kit サポートなどの Slack 専用ツール。                                                    |

## イベントソース

Slack adapter は主に次を処理します。

- `app_mention`
- `message`
- slash commands：`/pi-login`、`/pi-session`、`/pi-model`、`/pi-sandbox`、`/pi-new`、`/pi-admin`、`/pi-extensions`、`/pi-auto-reply` — 登録とルーティングはどちらも `src/commands/manifest.ts` から導出されますが、Slack App manifest 自体は依然として手動更新が必要です
- Block Kit actions
- assistant thread / status 関連 API

DM は mikan を直接起動します。共有 channel のメッセージには mention、interaction、または一致する auto-reply policy が必要です。channel thread 内の通常の mention なしの human reply は記録されますが、実行を開始しません。thread session isolation によって trigger policy が回避されることはありません。

## Session ルール

Slack には明確な channel と thread モデルがあるため、session key もそれに合わせて分かれます。

| Slack 状況                | sessionKey           |
| ------------------------- | -------------------- |
| Channel top-level message | `channelId`          |
| Thread reply              | `channelId:threadTs` |
| Event anchor run          | `channelId:anchorTs` |

これにより channel の会話と thread の会話は、それぞれ独立した session context を保持できます。

## 返信と形式

agent は標準の Markdown/GFM（platform 中立な response source）を書きます。Adapter はそれを Slack のネイティブ `markdown` block で render するため、bold、italic、strikethrough、inline およびフェンス付き code、link、ネストしたリスト、blockquote といった Markdown は Slack 自身がリッチテキストへ変換します。旧来の Slack 形式の `<url|label>` link は、render の前に `[label](url)` へ変換されます。Markdown のパイプ表はネイティブの Slack table block として render されます。

Slack adapter は次もサポートします。

- top-level または thread reply mode
- working / assistant status
- Slack のネイティブ streaming API（`chat.startStream` / `appendStream` / `stopStream`）と、編集ベースの進捗更新
- headings、paragraphs、lists、code fences、tables の Block Kit rendering
- ファイルアップロード

Block Kit output は Slack の制限に従います。散文は段落境界で最大 12,000 characters の `markdown` block に分割され、table cells は約 2,000 characters で切り詰められ、1 message は最大 50 blocks です。非常に大きな構造化結果には file output を使用してください。

## Mention

response source は platform 中立なので、モデルは prompt の Users 表にある名前を使って `<@userName>` と書きます。Adapter はそれを、送信のあらゆる経路 — 新規メッセージ、編集、stream delta のいずれでも — で Slack のネイティブな `<@U…>` 形式へ変換します。Slack は生の user id でしかリンクと通知を行わないためです。照合は `userName` と `displayName` を大文字小文字の区別なく対象とし、display name が他人の `userName` を覆い隠すことはなく、すでにネイティブな id はそのまま通過し、未知の名前は推測せずそのまま残します。2 つの stream delta にまたがって分割された mention は、その delta では未解決のままで、最終的な正規 render で解決されます。

## 添付ファイル

Slack file attachments は conversation office の `attachments/` directory に `<timestamp>_<sanitized-name>` としてダウンロードされ、その後 office 相対の path とともに mikan の共通 attachment metadata として runtime に渡されます。これはすべての adapter が使う共通ヘルパーであり、Slack adapter が担うのはダウンロードの呼び出しだけです。

## Stop 動作

`stop` / `/stop` は、まず現在の thread session を停止します。channel の top level で使われた場合、adapter は現在の running sessions から、対応する session を安全に停止できるか判断します。
