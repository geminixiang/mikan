---
title: agent-pm
description: チーム運用 pipeline の使い方 —— 何が届くのか、task をどう処理するか、そしてあなたの回答が次の判断をどう変えるか。
---

agent-pm はチームの周りで起きることを見張り、**人の判断が要るものだけ**をあなたに渡し
ます。これは extension です。誰かが会話にインストールすると、あとは普段 mikan と話すの
と同じように使えます。

このページは使い方です。インストールする側なら
[デプロイする人向け](#デプロイする人向け)へ。

## あなたが入っているループ

起きたことはすべて —— メッセージ、repository の変更、時報 —— 1 件の **event** として
記録されます。**workflow** と呼ばれるルールが各 event を見て、後続の動作があるかを判断
します。人にしかできない判断が必要なとき、workflow は **task** を作ってあなたに送ります。

そして本当に重要なのはここから。task を閉じるときに**どう終わったか**を伝えると、その
回答が **feedback** になります。これは事務手続きではありません。`no_action_needed` で
閉じることは、その workflow に「そもそも訊くべきではなかった」と伝えることであり、その
判断が次の似た event への振る舞いを変えます。雑に閉じた task は、間違ったことを教えます。

## 何が見えるか

Task は pipeline を所有する会話に、普通のメッセージとして届きます。見に行くのを覚えて
おかなければならない別ツールはありません。

pipeline が **test モード**で動いている場合、すべてのメッセージは 1 つの会話に迂回され、
**本来の宛先**が注記されます。これが既定であり、意図的です —— 人に通知する extension は、
設定ミス 1 つで全員に、しかも二重に通知するところまで来ています。テスト用チャンネルで
注記付きメッセージが見えるのは、壊れているのではなく動いている証拠です。

## 2 つの窓口、重なりはありません

どちらを使うかは、やろうとしていることで決まります:

| やりたいこと                                  | 方法                                   |
| --------------------------------------------- | -------------------------------------- |
| task を処理する —— 見る、閉じる、結果を伝える | **agent に話す。コマンドはありません** |
| pipeline を操作する —— 状態確認、即時実行     | `/pm …`、model を通しません            |

この分担は意図的です。pipeline の操作は機械的なのでコマンドにしてあります —— 正確で、
即座で、費用もかかりません。task の処理は判断なので agent を通します。「対応済み、あの
デプロイで直った」が何を意味するかを読めるのは agent だけだからです。

## task を処理する

自分の言葉で訊いてください。これが**唯一**の方法で、対応する `/pm` コマンドはありません:

> まだ残っているものは？
>
> task 12 を見せて
>
> task 12 を閉じて。対応済み —— あのデプロイで直った

閉じるときは**実際に何が起きたか**を伝えてください。結果は 4 種類あり、その task を作った
workflow にとって意味がそれぞれ違います:

| 結果               | こういうとき                                          |
| ------------------ | ----------------------------------------------------- |
| `resolved`         | task は正しく、あなたが対応した                       |
| `no_action_needed` | task は上がったが、実際には何もする必要がなかった     |
| `invalid`          | この task は存在すべきではなかった —— workflow の誤読 |
| `superseded`       | 別のことに追い越された                                |

価値があるのは後ろの 2 つです。`no_action_needed` と `invalid` は、workflow が「訊きすぎ
ている」と知る唯一の経路であり、その workflow への feedback として記録されます。すべてを
`resolved` で閉じると、この pipeline はあなたの注意を浪費していることに永遠に気づきません。

## 状態を見る

```
/pm status
```

```
agent-pm — 2026-08-01 (Asia/Taipei)
delivery: test → C0EXAMPLE2
schedules owned by: this conversation
events: 5 total · 0 pending · 0 unmatched
tasks: 0 open · workflows: 1 enabled
deliveries sent: 1 · failed runs: 0
```

読み方:

- **delivery** —— `test` はメッセージが迂回中、`live` は workflow が意図した宛先に届く
  ことを表します。
- **schedules owned by** —— pipeline のスケジュールはちょうど 1 つの会話に属します。別の
  会話が表示されているならスケジュールはそちらで動いており、コマンドと task tool はここ
  でも使えます。
- **unmatched** —— どの workflow も引き取らなかった event。この数字が見えなければ、
  「ルーティングの穴」と「静かな一日」は見分けがつきません —— だから捨てずに記録します。
- **failed runs** —— エラーになった workflow。ここが増え続けるならデプロイした人に伝える
  価値があります。

## いますぐ実行する

```
/pm all
```

スケジュールを待たず、全ステージを即実行します: 新しい event を取り込み、workflow と
突き合わせ、期限切れの task を掃きます。`/pm ingest`、`/pm run`、`/pm sweep` は 1 ステージ
ずつです。

何かが繋がっているかを確かめるのに使ってください。次の時報を 1 時間待つ必要はありません。

:::note[Slack ではコマンドの前に空白を 1 つ]
Slack のクライアントは `/` で始まる入力をすべて横取りし、Slack App に登録されたコマンド
しか送信しません。つまり `/pm` はあなたの端末から出ていきません。先頭に空白を入れて
` /pm status` と打てば Slack は普通のメッセージとして送り、agent-pm はそれをコマンドとして
読みます。Telegram、Discord、GitHub のコメントにこの横取りはありません。
:::

## 何も起きないとき

たいていは壊れているのではなく、想定どおりです:

- **コントロール会話が未設定。** 設定するまでスケジュールは 1 つも発火しません。
  `/pm status` がそう伝えますし、コマンドと task tool は使えます。
- **何もマッチしていない。** `unmatched` の数を見てください。event は来ているのにマッチ
  しないなら、足りないのは workflow であって、pipeline が止まっているわけではありません。
- **既定で有効な workflow は 1 つ。** 同梱されているのは、経路全体が通ることを証明する
  heartbeat です。本当に面白い供給源 —— repository、カレンダー、チャット履歴 —— は含まれて
  いません。組織自身の資格情報と識別データが要るからです。誰かが足す必要があります。次節へ。

## デプロイする人向け

インストールしてコントロール会話を設定します:

```sh
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --global
```

その会話で `/pi-new` を送って有効化し、
`<stateDir>/global/extension-data/agent-pm/config.json` を編集します:

```jsonc
{
  "controlConversationId": "C0EXAMPLE1", // スケジュールを所有し、配信先にもなる
  "deliveryMode": "test", // 出力を突き合わせてから "live" へ
  "testConversationId": "C0EXAMPLE2",
  "heartbeatHour": null, // null = その日の最初の tick、または Asia/Taipei の時刻を固定
  "scheduleOverrides": {}, // 例: {"run-workflows": "*/2 * * * *"}
}
```

丸一日の出力を見て納得するまで `deliveryMode` は `test` のままにしてください。`live` に
切り替えた瞬間が、ルーティングを誤った workflow が実在の人に届き始める瞬間です。

agent-pm は自分の extension を作るための参照例でもあります —— callback schedule、typed
tool、独自コマンド、SQLite 永続化、能動的な送信、同梱 skills が 1 か所にまとまっています。
その面については [Extension 開発](/ja/extension-development/)と
[ソース](https://github.com/geminixiang/mikan/tree/main/deploy/examples/extensions/agent-pm)
を読んでください。
