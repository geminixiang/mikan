# src/adapters

This directory contains external adapters for chat platforms and Web HTTP/OAuth/admin/session-view surfaces, plus shared adapter helpers.

Every adapter is constructed with a `Workspace` and reaches per-conversation
state through an `Office` resolved from a typed `OfficeAddress` (see
`src/office/`), which each intake carries on its event — no adapter takes a raw
conversation directory path. Every built-in adapter implements the shared
`MessagingBot.stop()` lifecycle boundary: Slack disconnects Socket Mode,
Discord destroys its client, Telegram stops polling, and GitHub clears polling
and webhook-debounce timers while waiting for an active poll to finish. Process
shutdown begins closing these external paths first and gives their accepted work
a bounded 30-second drain window. Conversation runtime closes after a successful
drain; on timeout it aborts stuck runner construction and the process reports a
failed shutdown.

## Contracts

- Adapters take the platform-neutral contract (`MessagingBot`, `ConversationEvent`, `ConversationMessage`, `ConversationResponder`) from `src/types.ts` and build events and messages with `createConversationEvent` / `createConversationMessage` from `src/office/index.ts`.
- `intake.ts` is the one ingress pipeline, ordered `magic word → trigger policy → attachments → log → busy policy → queue → dispatch`, with one cross-platform magic-word grammar; `stop` bypasses trigger policy and queueing. Adapters state platform policy as data (`magicWord.scopeFallback`, `busyPolicy`), not callbacks.
- Office writes go through `appendChannelLog(office, entry)` for `log.jsonl` and `saveIncomingAttachments(office, items)` for incoming files, which owns the `<timestamp>_<sanitized name>` convention, the office-relative `localPath`, and caller-order results. Downloads stream through `writeResponseToFile` and are rejected past `MAX_ATTACHMENT_BYTES` (100 MiB); retry and failure policy stay with each adapter.
- `progressive-renderer.ts` is the single owner of response state: operation order, source text, working indicators and typing, response identity, long-output splitting, and buffered or native streaming. Platform contexts provide only transport and rendering policy.
- The Web portals share `web/portal-shell.ts`, and request bodies are read through its size-limited `readRawBody` / `readJsonBody`. `web/server.ts` returns its `Server` handle so the composition root closes it before draining Conversation runtime work.
- Portals reach directories through the injected `Workspace`. Session View walks session lineage by `parentSessionId`, not by path.
