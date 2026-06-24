---
title: 工作階段
---

# 工作階段

mikan 會將平台聊天歷史與 pi-coding-agent 的結構化工作階段歷史分開。

## 平台工作階段模型

| 平台     | `sessionKey` 規則                                                                 | 備註                                                          |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Slack    | top-level / DM：`conversationId`；thread：`conversationId:threadTs`               | thread sessions 是由近期聊天歷史 bootstrap 的固定檔案         |
| Discord  | DM：`channelId`；shared top-level：`channelId:messageId`；reply/thread：rooted id | shared channels 中的 replies 會延續 root message session      |
| Telegram | private：`chatId`；shared top-level：`chatId:messageId`；reply chain：root reply  | 沒有原生 thread model；shared sessions 會從 reply chains 推斷 |

## 檔案

- `log.jsonl` 是面向平台、可供人閱讀的訊息歷史。
- `sessions/*.jsonl` 是結構化 pi-coding-agent context，包含 tool results。
- `sessions/current` 指向使用中的 top-level session。
- Thread/reply scopes 使用由 scope id 衍生的固定 session files。

## 重設

在聊天中使用 `new` / `/new` 重設目前工作階段。除非手動移除，先前的檔案會留在磁碟上供檢查。
