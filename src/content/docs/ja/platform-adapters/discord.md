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

## Session ルール

mikan は `resolveChatSessionKey()` を使い、共有 conversations を隔離します：

| 状況                    | Conversation/session identity                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| DM                      | conversation と session は DM channel ID を使用                                              |
| Guild top-level message | conversation は channel ID を使用し、trigger された message は message ID で scope 化        |
| Discord thread channel  | conversation は parent channel ID を使用し、session は `<parentChannelId>:<threadChannelId>` |
| 共有 channel 内の reply | session は referenced/root message ID から scope 化                                          |
| Slash command           | interaction の channel/thread context から解決                                               |

これにより、無関係な guild messages と threads が agent context を共有することを防ぎます。

## 返信と添付ファイル

Responder は Discord Markdown、typing indicators、initial replies、incremental message edits、reply targets、reactions、file uploads をサポートします。長い output は 1,900 characters を目安に Discord の message limit 未満へ分割されます。

受信した attachments は event が runtime に届く前に、sanitized file names で conversation の `attachments/` directory にダウンロードされます。

Guild slash-command acknowledgements は通常 ephemeral で、DM commands は直接返信します。

## 現在の境界

mikan は voice、embeds、components、polls、またはすべての Discord media/event types を agent input として扱いません。Thread/channel visibility は app installation と channel permissions に制限されます。
