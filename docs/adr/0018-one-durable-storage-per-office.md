---
status: accepted
---

# One durable storage per office; a thread forks its cause

ADR 0017 gave each session its own pi-durable storage, so mikan kept its own session layer around them: a header file per session for listing and lineage, a `current` pointer and archive names for `/new`, a parent found by the main session current at a thread's time, and snapshot copies for every read. A thread could not fork the channel's context, because a fork lives in its parent's storage, so it started from chat text instead: ten top-level messages from `log.jsonl`, with mikan's replies, and other bots' messages, written as the agent's own turns. In a thread under a channel run, the agent read "done" as something it said, found no tool output, and guessed or reran the command.

Measured on a copy of real data, a thread forked at the end of the run that caused it answered correctly 10 times in 10; every chat-text or empty start answered correctly at most 6 times in 10, even with the `history` tool, which cannot tell repeated runs apart. Production holds about 11,000 threads a month across 188 offices, up to 345 MB a month in one office. The evidence is in `docs/research/thread-session-origin-2026-10.md`.

## Decision

1. **Each office has one pi-durable SQLite storage**, opened with `openNodeSqliteStorage` in the office's State dir (ADR 0016). It replaces the per-session JSONL storages and header files of [ADR 0017](0017-pi-durable-harness.md) decision 2.
2. **Sessions are conversations.** The root conversation is the office's top-level session. A session-scoped document family, keyed by session key, maps every other session key to its conversation. Lineage is pi-durable's `ConversationRecord.parent`; listing is `scanConversations`.
3. **`/new` resets the conversation** with `Conversation.reset()`. Earlier history stays in storage and readable; the model context starts after the reset.
4. **A thread whose root a run caused forks that run.** A run writes a `mikan.run_cause` entry with its trigger's message ID when it starts. The two places that log a run's answer (the Slack response lifecycle and the progressive renderer) record the trigger's message ID and session key on the answer's log record. A new thread under a trigger or an answer forks the session that ran it at that run's last entry with `Conversation.fork()`. Any other thread is a new conversation holding only its root message.
5. **Chat history is never presented as the agent's turn.** Chat sync writes every synced message, mikan's included, as an attributed chat line, and keeps a reply logged with another session's key out of this session.
6. **The office's Harness is shared.** The first runner of an office opens it and the last closes it. On open, before anything is submitted, mikan aborts every unfinished ownerless task with `inspect()` and `abortTask()`, because scheduling resumes all conversations at once. The Harness selects no extension by default; each runner installs its own extension, named for its conversation, and configures its conversation, as it configures the root today.
7. **Reads go through the open Harness.** The `history` tool and the session view read conversations of the shared Harness instead of copying storage.
8. **`mikan migrate` imports v4 sessions straight into the office storage.** The current main session becomes the root; earlier main sessions and threads become ownerless conversations; each keeps its visible context and bookkeeping entries, as ADR 0017 decision 5 describes. The per-session JSONL format never shipped in a release and is removed without a migration.
9. **mikan requires Node 24.15 or later**, where `node:sqlite` is a release candidate.

## Considered Options

- **Keep one storage per session and copy the fork's context into the thread**: no layout change, but every thread stores its own copy of the channel's context, about 5.6 GB a month at production volume, more than all session data today.
- **One JSONL storage per office**: the same model on the default backend, but JSONL decodes the whole storage into memory on open: 1 s and 365 MB for 2,000 threads in a test, where SQLite took 1 ms and 13 MB.
- **Seed threads from chat text, or start them empty, and rely on the `history` tool**: no storage change, but the agent answered correctly at most 6 times in 10.
- **Find a thread's fork point by matching text**: the design of May 2026; it needs no record but matches the wrong message when text repeats and misses a root not yet written.

## Consequences

- A corrupt storage loses the office's channel and threads together, not one session.
- Threads imported by the migration have no fork parent; only threads created afterwards do.
- `node:sqlite` prints an `ExperimentalWarning` on load.
- The storage keeps raw history forever, as JSONL did; nothing reclaims a reset conversation's entries.
- Notices, command replies, Block Kit messages, and uploads carry no trigger, so a thread under one starts from its root alone.
- Session identity for prompt caching, usage, and logs moves from the header's session ID to the conversation, recorded in the session index.
