# src/sessions

This directory manages synchronization between chat history and harness session files, plus session policy, lineage, and metadata.

Session files live in `Office.sessionsDir`, under the office's State dir, which
no sandbox sees (ADR 0016); paths stored in their headers are never opened.
Per-key runtime
state is office-keyed — but the **session key itself stays a raw platform
value** (`conversationId[":"suffix]`). Office keys name directories; session
keys name conversations as the platform reports them.

A session is a private one-line JSON header file beside a pi-durable JSONL
storage directory, `<session>.durable` (ADR 0017). The header is an index of
what listing and lineage need without opening storage: session ID, creation
time, working directory, parent session ID, and the legacy `source` marker. It
has no version of its own: the State migration record decides which format the
files are in. The session's thread is
the storage's root conversation; its name and last run record are the
`mikan.session` document, and host bookkeeping entries are `mikan.custom`
entries. `mikan migrate` converts older files (see `src/migrations/`).

## Keeping up with Pi

Session integration must stay easy to upgrade: use pi-durable's public storage,
Harness, and conversation interfaces, not private `dist` imports, copied
execution logic, or speculative compatibility layers. Pi owns entries, commits,
compaction, and recovery; mikan owns Office paths, platform history, and
resource lifetime.

`SessionStore` opens one Harness per storage with late-bound models, settings,
and execution environment, so stores opened before a run can read and write
bookkeeping without a model. Entry IDs are qualified with the session ID because
durable IDs restart at 1 in every storage. Inspection copies the storage
directory first, because one process owns a storage and nothing may repair the
live copy.

`compaction-summary.ts` recognizes the user message pi-durable wraps a
compaction summary in; the wrapper text is not exported upstream, so
`harness-runner.test.ts` checks it against a real compaction.

## Contracts

- `ChatHistorySync` reads the platform `log.jsonl`, skipping malformed lines and coalescing consecutive bot chunks that share a `ts`, because one streamed response is logged in pieces. Command recognition is injected (`isCommandText`).
- `history-line.ts` owns the prompt history-line grammar `[timestamp] [user] [in-thread:ts]: text`; its writer and parser are round-trip tested.
- `session-key.ts` owns the session-key grammar. Nothing else may split on `:`, and conversation ids never contain `:`.
- `SessionStore` holds the single live-writer lease for a session file. Closing disposes MCP connections, then the harness, Session, repository, and writer lease; a cleanup failure never skips writer release, and `close()` is single-flight. Runner construction closes the writer before reporting a later materialization failure, so the same session can be rebuilt immediately.
- A thread's parent is the main session that was current at the thread's timestamp, stable across `/new`, recorded as `parentSessionId`; lineage is resolved by ID inside the same sessions directory, never by path.
- The offline migrations verify each result before swapping it in, hard-link the original as `*.v3.bak` or `*.pi-084.bak`, and leave the original in place on any failure.
