---
title: Sessions
---

# Sessions

mikan separates platform chat history from pi-coding-agent structured session history.

## Platform session model

| Platform | `sessionKey` Rule                                                                 | Notes                                                                  |
| -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Slack    | top-level / DM: `conversationId`; thread: `conversationId:threadTs`               | thread sessions are fixed files bootstrapped from recent chat history  |
| Discord  | DM: `channelId`; shared top-level: `channelId:messageId`; reply/thread: rooted id | replies in shared channels continue the root message session           |
| Telegram | private: `chatId`; shared top-level: `chatId:messageId`; reply chain: root reply  | no native thread model; shared sessions are inferred from reply chains |

## Files

- `log.jsonl` is the platform-facing, human-readable message history.
- `sessions/*.jsonl` is the structured pi-coding-agent context, including tool results.
- `sessions/current` points at the active top-level session.
- Thread/reply scopes use fixed session files derived from the scope id.

## Resetting

Use `new` / `/new` in chat to reset the current session. The previous files remain on disk for inspection unless manually removed.
