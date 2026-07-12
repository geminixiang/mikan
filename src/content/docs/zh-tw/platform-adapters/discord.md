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

## Session 規則

mikan 使用 `resolveChatSessionKey()` 隔離共享對話：

| 情境                    | Conversation/session identity                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- |
| DM                      | conversation 與 session 使用 DM channel ID                                            |
| Guild top-level message | conversation 使用 channel ID；觸發的訊息以 message ID 設定 scope                      |
| Discord thread channel  | conversation 使用 parent channel ID；session 為 `<parentChannelId>:<threadChannelId>` |
| 共享頻道中的 reply      | session 以 referenced/root message ID 設定 scope                                      |
| Slash command           | 從 interaction 的 channel/thread context 解析                                         |

這可避免不相關的 guild 訊息與 threads 共用 agent context。

## 回覆與附件

Responder 支援 Discord Markdown、typing indicators、initial replies、incremental message edits、reply targets、reactions 與檔案上傳。長輸出會以 1,900 字元為目標，在 Discord message 限制前切分。

收到的 attachments 會先以安全化檔名下載到對話的 `attachments/` 目錄，再由 event 傳到 runtime。

Guild slash-command acknowledgements 通常是 ephemeral；DM commands 則直接回覆。

## 目前限制

mikan 不會把 voice、embeds、components、polls 或每種 Discord media/event type 都當成 agent input。Thread/channel visibility 受 app installation 與 channel permissions 限制。
