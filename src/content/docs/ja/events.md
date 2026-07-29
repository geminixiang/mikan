---
title: イベント
description: workspace の events ディレクトリを通じて agent を起動するイベント形式と処理フロー。
---

## イベントファイルの置き場所

イベントファイルは `<workspace>/events/` にあります。どの office directory の中でもなく、workspace root に置かれます。この scheduling bus は意図的に workspace 全体で共有されます。watcher が polling する 1 つの directory を、すべての conversation が共有します。また agent が書き込み可能でもあるため、`conversationId` による所有権は協調的な規約であって認可の境界ではありません。イベントのテキストに secrets を入れないでください。

agent の `event` tool は、既定では現在の conversation のイベントだけを列挙します。ファイルが一致するのは、その `conversationId` **と** `platform` の両方が実行中の office と一致する場合です。payload が `platform` を持つ以前に書かれたファイルは、生 id を共有するどの conversation からも見えたままになります。`scope=all` は directory 内のすべてを列挙します。

## イベントタイプ

### 即時

harness がファイルを見つけるとすぐに起動します。外部スクリプトや webhook からシグナルを送る用途に適しています。

```json
{
  "type": "immediate",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "New GitHub issue opened"
}
```

### 単発

指定時刻に一度だけ起動します。リマインダーや将来の callback に適しています。

```json
{
  "type": "one-shot",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Remind Mario about dentist",
  "at": "2025-12-15T09:00:00+01:00"
}
```

`at` は `Z` または明示的な `±HH:MM` UTC offset で終わる ISO 8601 タイムスタンプでなければなりません。

### 定期

cron スケジュールに従って起動します。ファイルが削除されるまで残り続けます。

```json
{
  "type": "periodic",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Check inbox and summarize",
  "schedule": "0 9 * * 1-5",
  "timezone": "Asia/Taipei"
}
```

Cron 形式: `minute hour day-of-month month day-of-week`

よく使うスケジュール:

- `0 9 * * *` — 毎日 09:00
- `0 9 * * 1-5` — 平日 09:00
- `0 0 1 * *` — 毎月 1 日の午前 0 時

## ルーティングフィールド

`type`、`conversationId`、`text` はすべてのイベントファイルで必須です。その他は任意で、タイプ固有のフィールド（`at`、`schedule` + `timezone`）はそのタイプでのみ必須です。schema を所有するのは `src/harness/event-format.ts` であり、すべての reader と writer はその parser と builder を経由します。

| フィールド         | 説明                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform`         | 対象 bot プラットフォーム（例: `slack`）。省略すると、生の conversation id を共有する 2 つのプラットフォームがある場合に曖昧になります           |
| `conversationId`   | 送信先の生のプラットフォームチャンネルまたは DM ID。office key ではありません。`channelId` は legacy な読み取り専用 alias として受け付けられます |
| `conversationKind` | `"shared"`（チャンネル）または `"direct"`（DM）                                                                                                  |
| `userId`           | このイベントを要求したプラットフォームユーザー ID。per-user モードでは vault/credential routing に使われます                                     |

## Session バインディング

イベントファイルには `sessionKey` や thread 目標は含まれません。スケジュール/バックグラウンドイベントは、それを作成したリアルタイムチャットターンの続きではないため、イベント本文は自己完結している必要があります。

| プラットフォーム/イベントソース  | 見える配信方法                | Session key                                     | Thread 目標    |
| -------------------------------- | ----------------------------- | ----------------------------------------------- | -------------- |
| Slack event file/tool            | 新しいトップレベルのアンカー  | `<conversationId>:<anchor message ts>`          | なし           |
| Slack direct `ConversationEvent` | 指定された `thread_ts` を優先 | 設定されていれば `<conversationId>:<thread_ts>` | 任意           |
| その他のプラットフォームイベント | プラットフォーム adapter 既定 | プラットフォーム adapter 既定の event session   | adapter に依存 |

Slack イベントファイルでは、イベント起動時にまずトップレベルの Slack メッセージを作成します。そのメッセージのタイムスタンプがアンカーになり、その実行では固定 session key `<conversationId>:<anchor message ts>` を使います。

これにより、イベント実行はチャンネル内で見える状態になり、永続的な top-level session から隔離されます。トップレベルチャンネル履歴は明示的な検索用に `log.jsonl` で引き続き利用できますが、イベント session へ暗黙にコピーされることはありません。

## Thread 目標

イベントはトップレベルメッセージとして配信されます。古い threads や reply chains の中に埋めるべきではありません。

agent の `event` tool はルーティングフィールドを自動入力します。JSON を手書きせず、これを使ってください。

## ライフサイクル

- **即時** と **単発** ファイルは、正常に配信された後に削除されます。
- 無効、期限切れ、配信不能、または queue overflow となった即時/単発ファイルも削除されます。失敗はログまたは Sentry で確認してください。
- **定期** ファイルは残り続けます。ファイルを削除するとキャンセルできます。
- 一度に最大 5 個のイベントをキューに入れられます。それを超える即時/単発ファイルは、上記のとおり破棄されます。

## サイレント応答

報告する内容がない定期イベントでは、正確に `[SILENT]` と応答してください。harness はステータスメッセージを削除し、チャンネル荒らしを避けるためにプラットフォームへ投稿しません。

## Debouncing

即時イベントを送信するスクリプト（email watchers、webhook handlers）を書くときは、debounce してください。各項目ごとにイベントを送るのではなく、一定の時間枠でイベントを集め、1 つの要約イベントを送信してください。
