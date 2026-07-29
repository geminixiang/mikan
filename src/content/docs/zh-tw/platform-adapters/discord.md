---
title: Discord 接入
description: 設定 Discord gateway intents、權限、sessions、commands、attachments 與回應行為。
---

## 設定

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 建立 application 與 bot。
2. 在 **Bot → Privileged Gateway Intents** 下啟用 **Message Content Intent**。mikan 會要求此 intent；沒有它就無法檢查一般訊息文字。
3. 使用 `bot` 與 `applications.commands` scopes 安裝 app。
4. 授予 bot 服務頻道所需的存取權：View Channels、Send Messages、Read Message History、Add Reactions、Attach Files、Embed Links 與 Send Messages in Threads。
5. 設定 token 並啟動 mikan：

```bash
export DISCORD_BOT_TOKEN="..."
mikan /path/to/workspace
```

Channel permission overrides 仍會生效。成功安裝不保證能存取每個 guild channel 或 private thread。

## 事件來源與觸發條件

Adapter 處理：

- DM、guild channels 與 Discord thread channels 中的 `messageCreate`
- slash commands：`login`、`session`、`new`、`stop`、`model` 與 `sandbox`
- message attachments

DM 會直接觸發。Guild 訊息通常需要 mention、mikan 處理的 reply/thread context，或符合 auto-reply policy。Stop commands 會在一般 trigger gate 前檢查。

## Slash command 註冊

這個 adapter 不維護自己的指令清單。連線時，它會透過 `application.commands.set()` 註冊 `src/commands/manifest.ts` 中每一筆標記為 Discord 的項目，名稱、說明與選用的字串參數都直接取自該項目。因此新增一個指令是新增一筆 manifest 項目，而不是修改 adapter。

只要指令或 option 的說明超過 100 個字元，Discord 就會拒絕該次註冊，而且整個 `set()` 呼叫都會失敗——這會讓該 guild 悄悄停留在過時的指令清單上，直到下次重新啟動。因此有一個單元測試會對每一筆 manifest 說明強制 100 字元的上限，讓這種失敗改在測試階段就浮現。

## Session 規則

mikan 使用 `resolveChatSessionKey()` 隔離共享對話。Discord 會傳入 `persistentTopLevel: true`，因此頻道的 top-level 對話會保有一個持久的 session，而不是每則觸發訊息都分岔出一個新的：

| 情境                    | Conversation id   | Session key                           |
| ----------------------- | ----------------- | ------------------------------------- |
| DM                      | DM channel ID     | 同一個 DM channel ID                  |
| Guild top-level message | channel ID        | 同一個 channel ID                     |
| Discord thread channel  | parent channel ID | `<parentChannelId>:<threadChannelId>` |
| Guild 頻道中的 reply    | channel ID        | `<channelId>:<referencedMessageId>`   |
| Slash command           | 同上              | 從 interaction 的 context 解析        |

因此 thread 與 reply 會分岔出自己的 session，而一般的頻道閒聊則延續該頻道那個持久的 session。Reply 的 scope 是它直接引用的那則訊息，而不是 thread root——對單純的頻道 reply，Discord 並不提供 thread root。DM reply 是例外：DM 本來就是私人對話，因此它會停留在裸的 channel key 上，不會為每則 reply 分岔。

## 回覆與附件

Responder 支援 Discord Markdown、typing indicators、initial replies、incremental message edits、reply targets、reactions 與檔案上傳。長輸出會以 1,900 字元為目標，在 Discord message 限制前切分。

收到的 attachments 會在 event 傳到 runtime 之前，透過其他 adapter 共用的同一個 helper，以 `<timestamp>_<sanitized-name>` 下載到該對話 office 的 `attachments/` 目錄。

Guild slash-command acknowledgements 通常是 ephemeral；DM commands 則直接回覆。

## 目前限制

mikan 不會把 voice、embeds、components、polls 或每種 Discord media/event type 都當成 agent input。Thread/channel visibility 受 app installation 與 channel permissions 限制。
