# src/sessions

This directory manages synchronization between chat history and harness sessions, plus session policy, lineage, and metadata.

Each office keeps its sessions in one pi-durable SQLite storage, `Office.sessionsPath`, under the office's State dir, which no sandbox sees (ADR 0016, ADR 0018). Per-key runtime state is office-keyed, but the **session key itself stays a raw platform value** (`conversationId[":"suffix]`). Office keys name directories; session keys name conversations as the platform reports them.

The top-level session is the storage's root conversation; every other session is a conversation that the `mikan.sessions` document maps from its session key, with the session's ID and creation time. Sessions that `mikan migrate` imported from earlier `/new` generations have `earlier:<id>` keys. A session's name and last run record are its `mikan.session` document, and host bookkeeping entries are `mikan.custom` entries.

## Keeping up with Pi

Session integration must stay easy to upgrade: use pi-durable's public storage, Harness, and conversation interfaces, not private `dist` imports, copied execution logic, or speculative compatibility layers. Pi owns entries, commits, compaction, recovery, forks, and resets; mikan owns Office paths, platform history, and resource lifetime.

All sessions of an office share one Harness, opened by the first `SessionStore` and closed by the last, because one process owns a storage. Its models, settings, and execution environment are late-bound, so stores opened before a run can read and write bookkeeping without a model; each run binds its own models and environment to its conversation. The Harness selects no extension by default, and each `MikanAgentSession` installs and selects one named for its conversation. Entry IDs are qualified with the session ID because durable IDs number the whole storage.

pi-durable passes no conversation to `Models`, so a shared Harness cannot tell whose request it is sending. Each conversation's `beforeRequest` hook returns the request's messages with a copied last message, and the shared `Models` looks that object up to route the request to the conversation's own session ID, budget, and counters. This relies on generation passing the hook's message objects to `Models` without copying them, which pi-durable does not document; `office-sessions.test.ts` pins it. Replace it once pi-durable carries conversation-scoped request options. Compaction summaries have no such hook; a conversation's `beforeCompact` hook counts and limits them instead.

`compaction-summary.ts` recognizes the user message pi-durable wraps a compaction summary in; the wrapper text is not exported upstream, so `harness-runner.test.ts` checks it against a real compaction.

## Contracts

- `ChatHistorySync` reads the platform `log.jsonl`, skipping malformed lines and coalescing consecutive bot chunks that share a `ts`, because one streamed response is logged in pieces. Command recognition is injected (`isCommandText`).
- `history-line.ts` owns the prompt history-line grammar `[timestamp] [user] [in-thread:ts]: text`; its writer and parser are round-trip tested.
- `session-key.ts` owns the session-key grammar. Nothing else may split on `:`, and conversation ids never contain `:`.
- `SessionStore` holds the single live-writer claim for a session within the process. Closing disposes MCP connections, then unbinds the run and releases the claim and the storage reference; a cleanup failure never skips the release, and `close()` is single-flight. Runner construction closes the writer before reporting a later materialization failure, so the same session can be rebuilt immediately.
- Opening an office storage aborts every unfinished ownerless task before anything is submitted, because the first submission resumes work in all conversations, and a resumed run has no runner to present it.
- A run appends a `mikan.run_cause` entry with the message that started it, and the platform logs its answer with `replyTo` (that message) and `sessionKey`. A new thread whose root is such an answer, or the message it answers, forks the cause session at that run's last answer (`SessionStore.forkRun`); any other thread starts from its root and its replies. Fork lineage is the thread's parent.
- Chat sync never writes an assistant message: a synced log record enters as an attributed user line, and a bot record that carries a `sessionKey` is a run answer that stays in its own session.
- `/new` resets the session's conversation; earlier entries stay in storage, and chat sync records the reset time so it does not replay older messages.
- Another process must not open a live office storage: one process owns it. Read a copy made with SQLite's backup API, as the Slack E2E does.
- The offline migrations verify each result before swapping it in, keep the originals (`*.v3.bak`, `sessions-v4/`), and leave them in place on any failure.
