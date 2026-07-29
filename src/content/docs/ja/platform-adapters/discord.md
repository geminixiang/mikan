---
title: Discord 接続
description: Discord gateway intents、permissions、sessions、commands、attachments、response behavior を設定します。
---

## セットアップ

1. [Discord Developer Portal](https://discord.com/developers/applications) で application と bot を作成します。
2. **Bot → Privileged Gateway Intents** で **Message Content Intent** を有効にします。mikan はこの intent を要求し、これがないと通常の message text を調べられません。
3. `bot` と `applications.commands` scopes を使って app をインストールします。
4. 対象 channels で必要な権限を bot に付与します：View Channels、Send Messages、Read Message History、Add Reactions、Attach Files、Embed Links、Send Messages in Threads。
5. token を設定し、mikan を起動します：

```bash
export DISCORD_BOT_TOKEN="..."
mikan /path/to/workspace
```

Channel permission overrides は引き続き適用されます。インストールに成功しても、すべての guild channels や private threads にアクセスできるとは限りません。

## イベントソースと trigger

Adapter は次を処理します：

- DMs、guild channels、Discord thread channels の `messageCreate`
- slash commands：`login`、`session`、`new`、`stop`、`model`、`sandbox`
- message attachments

DM は直接起動します。Guild messages には通常、mention、mikan が処理する reply/thread context、または一致する auto-reply policy が必要です。Stop commands は通常の trigger gate より先に確認されます。

## Slash command の登録

Adapter は独自のコマンドインベントリを持ちません。接続時に、`src/commands/manifest.ts` の
エントリのうち Discord 向けにマークされたものをすべて `application.commands.set()` で登録し、
名前・description・任意の string 引数はエントリからそのまま取得します。したがってコマンドの
追加は manifest へのエントリ追加であって、adapter の編集ではありません。

Discord は、コマンドまたは option の description が 100 文字を超える登録を拒否し、`set()` 呼び出し
全体が失敗します。そうなると、次回の再起動まで guild には古いコマンド一覧が残ったままになります。
その失敗が代わりにテスト時に表面化するよう、unit test が manifest のすべての description に対して
100 文字の上限を強制します。

## Session ルール

mikan は `resolveChatSessionKey()` を使い、共有 conversations を隔離します。Discord は
`persistentTopLevel: true` を渡すため、channel の top-level conversation は、trigger される
メッセージごとに新しい session を分岐させるのではなく、1 つの永続 session を保ちます：

| 状況                     | Conversation id   | Session key                           |
| ------------------------ | ----------------- | ------------------------------------- |
| DM                       | DM channel ID     | 同じ DM channel ID                    |
| Guild top-level message  | channel ID        | 同じ channel ID                       |
| Discord thread channel   | parent channel ID | `<parentChannelId>:<threadChannelId>` |
| Guild channel 内の reply | channel ID        | `<channelId>:<referencedMessageId>`   |
| Slash command            | 上と同じ          | interaction の context から解決       |

つまり thread と reply は自分の session を分岐させ、通常の channel でのやり取りは channel の
永続 session を継続します。reply は、Discord が通常の channel reply には提供しない thread root
ではなく、直接参照しているメッセージに scope 化されます。DM は例外です。DM はすでにプライベートな
conversation なので、reply ごとに分岐せず、そのままの channel key に留まります。

## 返信と添付ファイル

Responder は Discord Markdown、typing indicators、initial replies、incremental message edits、reply targets、reactions、file uploads をサポートします。長い output は 1,900 characters を目安に Discord の message limit 未満へ分割されます。

受信した attachments は event が runtime に届く前に、他の adapter と同じ共通ヘルパーを通じて、conversation office の `attachments/` directory に `<timestamp>_<sanitized-name>` としてダウンロードされます。

Guild slash-command acknowledgements は通常 ephemeral で、DM commands は直接返信します。

## 現在の境界

mikan は voice、embeds、components、polls、またはすべての Discord media/event types を agent input として扱いません。Thread/channel visibility は app installation と channel permissions に制限されます。
