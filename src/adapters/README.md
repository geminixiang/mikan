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
- `intake.ts` is the one ingress pipeline, ordered `magic word → trigger policy → attachments → log → busy policy → queue → dispatch`, with one cross-platform magic-word grammar; `stop` bypasses trigger policy and queueing. Adapters state platform policy as data (`magicWord.scopeFallback`, `busyPolicy`), not callbacks. A message the queue admits behind earlier work gets a ⏳ reaction through the adapter's `react`; it is never removed, because it records that the message waited, and a failed reaction never affects delivery.
- Office writes go through `appendOfficeLog` / `appendBotResponseLog` (`src/office/log.ts`) for `log.jsonl`, which every reader also parses through `readOfficeLog`, and `saveIncomingAttachments(office, items)` for incoming files, which owns the `<timestamp>_<sanitized name>` convention, the office-relative `localPath`, and caller-order results. Downloads stream through `writeResponseToFile` and are rejected past `MAX_ATTACHMENT_BYTES` (100 MiB); retry and failure policy stay with each adapter.
- Every adapter's `enqueueEvent` goes through `MessagingEventQueue.offerEvent`, which owns the per-conversation backlog limit (`MAX_PENDING_EVENTS` waiting behind the running event) and its discard log.
- `progressive-renderer.ts` is the single owner of response state: operation order, source text, working indicators and typing, response identity, long-output splitting, and buffered or native streaming. Platform contexts provide only transport and rendering policy.
- The Web portals share `web/portal-shell.ts`, and request bodies are read through its size-limited `readRawBody` / `readJsonBody`. `web/server.ts` returns its `Server` handle so the composition root closes it with `closeWebServer` before draining Conversation runtime work. Session View live streams never end on their own, so `closeWebServer` drops idle connections at once and every remaining connection after a short grace; a plain `server.close()` would hold shutdown open for as long as any viewer keeps the page open.
- Session View's live stream renders the `RunEvent`s that the harness publishes for the viewed office session through the composition root's `RunEventHub`, so a run started from any chat platform appears live, not only runs sent from the page. A page-sent message runs with a silent responder and reaches the page through the same run events; the dispatch reports only failures that happen before a run starts.
- Portals reach directories through the injected `Workspace`. Session View walks session lineage by `parentSessionId`, not by path.
