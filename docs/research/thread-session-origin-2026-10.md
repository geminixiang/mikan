# How a thread session should start (research, 2026-10)

Question: what context should a new thread session start from, so the agent never mistakes chat text for its own memory? Draft decision: ADR 0018 (proposed). This file records the evidence; numbers come from a local QA channel with one compaction and about 880 entries.

## Today

- A thread session is a new storage seeded from `log.jsonl`: the ten top-level messages before its root, the root, and the thread so far (`selectThreadBootstrapMessages` in `src/sessions/chat-history-sync.ts`).
- Chat sync writes every log record with `isMessagingBot` as an assistant message (`buildHistorySessionMessage`). `isMessagingBot` means any bot: mikan, and other apps (`logExternalMessagingBotMessage` in `src/adapters/slack/bot.ts`).
- In the QA channel session, 216 of 425 assistant messages were synced, not produced by the session: 143 from another bot, 69 mikan replies from other sessions, 4 other.
- Effect: in a thread under a channel reply, the agent reads the reply as its own turn, sees no tool call, and guesses or reruns the command. With the `history` tool and a prompt rule, it looked the result up in two of three trials.

## History

| Date       | Commit                 | Thread start                                                      |
| ---------- | ---------------------- | ----------------------------------------------------------------- |
| 2026-04-06 | `7f5f0c13`             | Fork of the whole channel session                                 |
| 2026-05-02 | `9287325f`             | Fork up to the root, found by normalized text match, with retries |
| 2026-06-01 | `214b47ac`, `72659154` | Seed from `log.jsonl`; fork code removed                          |

The June change aimed to cut cost; no commit or document recorded a reason.

## Findings

### pi-durable forks

- `Conversation.fork(entryId)` gives a conversation whose context ends at the entry and starts at the newest compaction summary before it (spec §2.1, §3.7). Measured: a fork after the compaction held the summary plus 345 messages; one before it held 274 raw messages; each took 2–3 ms.
- A fork lives in the same storage as its parent. mikan keeps one storage per session (ADR 0017), so a thread in its own storage can only copy a fork's context.
- Copy path, public API only: snapshot the channel storage (as `SessionStore.inspect` does), fork in the snapshot, read `context()`, append the messages to the thread storage. Measured: about 100 ms in total and 0.2–0.5 MB per thread; the copy rereads with the same message count.

### Copying a live storage

JSONL storage appends sidecar records, then a main marker (spec §11.3). A copy that takes `main.jsonl` after a later commit but a sidecar before it is reported as corruption on open; reclamation renames or removes sidecars. Copying is safe only while the parent commits nothing. `waitForParentSession` already holds a new thread until the parent run settles, but a parent run that starts during the copy can still race. `SessionStore.inspect` (the `history` tool, session view) has the same race today.

### Cost

| Thread start                 | First request uncached | Cached    |
| ---------------------------- | ---------------------- | --------- |
| Ten-message seed (today)     | about 14k              | about 12k |
| Fork near the channel's tail | about 1k               | about 30k |
| Fork at an old point         | about 31k              | 0         |

The local OpenAI-compatible provider reused the prefix across different session IDs. The production provider is unmeasured.

Compaction: pi-durable defaults with a 128k window block at 111,616 tokens and start background compaction at 78,848. A fork inherits up to that size, so a thread under a large channel context may compact within a few turns, one summary request each time.

### How threads start, per platform

| Platform and case                | Session key                          | Root's cause                                                 |
| -------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| Slack thread                     | `<channel>:<thread_ts>`              | The root message                                             |
| Slack `replyMode: "thread"`      | Reply posted in the trigger's thread | The channel run, so the next thread message starts a session |
| Discord thread                   | `<parent>:<threadId>`                | Thread ID equals the source message ID (Discord API docs)    |
| Discord and Telegram reply       | `<channel>:<referencedId>`           | Any session that posted the referenced message               |
| Telegram group top-level         | `<chat>:<messageId>`                 | No persistent channel session exists                         |
| GitHub                           | One session per issue or PR          | No threads                                                   |
| Scheduled event, handed-off task | Their own thread session             | The run already executes there                               |

Discord, Telegram, and GitHub log bot replies without `threadTs` (`appendBotResponseLog` callers). Sync then treats a Discord thread reply as top-level and writes it into the channel session.

### Finding the run that caused a root

- A session stores no platform message ID for a run: the prompt carries a time and a name, `SessionDoc.run` keeps only the latest run, and only steering writes `mikan.control_input{messageId}`.
- Slack channel runs are serial (one queue per session key), so "the latest run started before this mikan message" is unique. It misassigns mikan messages no run posted: stop and restart notices, command replies, event anchors.
- Message IDs a run posts are not recorded. Posting paths: the progressive renderer, Block Kit (`main.ts`), uploads, stop handling (`conversation-runtime.ts`), task roots and event anchors (`slack/bot.ts`).
- The session view already guesses a thread's anchor by timestamp, shared IDs, or content (`findThreadAnchorEntryId`); a recorded cause would replace the guess.

### Chat sync dedupe

`syncSessionManagerFromLog` skips records that the session already holds by comparing role and normalized text (`consumeRepresentedLogMessage`, `presentedAnswerKey`). Writing synced bot messages as attributed user lines changes their comparison key, so a resync without a marker would duplicate them. The marker path (`lastMessageId`) is unaffected.

### One storage per channel (B1), revisited

- pi-durable supports it: the scheduler runs tasks across conversations, and `EnvTarget` and the tool API carry `conversationId`.
- mikan binds one harness to one `SessionStore` and binds tools per run in shared closures (`toolBindings.set*Context`), so two threads running at once in one storage would overwrite each other's run context. The writer lease, MCP lifetime, archive and `/new`, the session view, and the `history` tool all assume one session per storage.
- `main.jsonl` is never compacted (spec §11.3), so every thread's history makes the channel storage slower to open and to snapshot.

## Round 3 experiments

Scripts live outside the repository tree that ships; each reruns against a copy of local QA data.

### Reproducing the wrong answer offline

A thread under a channel run asks "what was that output?". The script rebuilds four thread starts from real storage, sends them with the real system prompt and the `bash` and `history` tool schemas, and classifies the first response over 10 trials each.

| Thread start                            | Prompt before `504ab592` | Current prompt | Old prompt, no `history` tool |
| --------------------------------------- | ------------------------ | -------------- | ----------------------------- |
| Ten-message seed (today)                | bash 8, history 2        | history 10     | bash 10                       |
| Seed with bot turns as `[mikan]:` lines | bash 6, history 4        | history 10     | —                             |
| Fork at the end of the cause run        | history 9, correct 1     | history 10     | correct 9, bash 1             |
| Root only                               | bash 7, history 3        | history 10     | —                             |

- The seed reproduces the rerun: 8 of 10 with the old prompt, 10 of 10 without the tool.
- Relabeling bot turns alone helps little (6 of 10 still rerun).
- A fork answers from its own context (9 of 10) when no `history` tool is offered; with the tool, it looks the result up first even though the answer is in its context.
- The current prompt sends every start to `history`. The live failure after that prompt (one rerun in three) did not reproduce offline, so the offline setup is narrower than a live run: fewer tools, no thinking, one turn.

### Snapshot race

1,000 `SessionStore.inspect` snapshots taken while the same process committed about 2,700 entries produced no open failure. `cpSync` blocks the event loop, so only an append already handed to the thread pool can land mid-copy; the race stays theoretical within one process.

### One storage with many threads (B1)

A JSONL storage holding a 300-entry channel plus N forked threads of 40 entries each:

| Threads | Size    | Files | Copy   | Open   | Thread `context()` |
| ------- | ------- | ----- | ------ | ------ | ------------------ |
| 50      | 4.2 MB  | 205   | 20 ms  | 32 ms  | under 1 ms         |
| 200     | 15.3 MB | 805   | 74 ms  | 116 ms | 1 ms               |
| 500     | 37.6 MB | 2,005 | 190 ms | 263 ms | 1 ms               |

Open and copy grow linearly. Copying each fork into its own storage (B2) instead stores the inherited prefix once per thread: about 0.45 MB each at this channel size, about 225 MB for 500 threads.

### Linking a root to its run

In the QA channel, 67 of 165 top-level mikan messages are not run answers: 47 notices (stopped, nothing running, could not complete) and 20 empty event anchors. "The latest run before the message" would misassign them.

Every run answer is logged at two places that hold the triggering event: `ProgressiveRenderer` (Telegram, Discord, GitHub) and the Slack response lifecycle. A `replyTo` field with the trigger's message ID on those log records links a bot root to its trigger, and a `mikan.run_cause` entry at run start links the trigger to an entry in the session. Other posts (notices, command replies, Block Kit, uploads) carry no `replyTo`, so a thread under them starts from its root alone. `log.jsonl` is agent-writable, but a forged `replyTo` can only select a session of the same office.

## Round 4 experiments

### End to end, with tools executed

The same four starts, now running each tool call (`history` against the real office through `runHistory`, `bash` returning a fresh value) for up to five steps and grading the final answer. 10 trials each; "rerun" means the agent called `bash` again.

| Thread start                      | Prompt before `504ab592`    | Current prompt              |
| --------------------------------- | --------------------------- | --------------------------- |
| Ten-message seed (today)          | correct 2, rerun 8          | correct 6, "not found" 4    |
| Seed with bot turns as `[mikan]:` | correct 3, rerun 4, other 3 | correct 5, rerun 1, other 4 |
| Fork at the end of the cause run  | correct 10                  | correct 10                  |
| Root only                         | correct 2, rerun 7, other 1 | correct 6, rerun 1, other 3 |

- Only the fork answers correctly every time, with either prompt. It averaged the fewest uncached input tokens per trial (about 2.2k, against 2.3k–3.7k), because its prefix matches the channel's cache.
- `history` lookups fail even when the result holds the answer: the same command ran several times, the search returns all of them, and the agent cannot tell which run "that" means; queries padded with extra words match nothing. The fork's context ends at the cause run, so the ambiguity never arises.
- The trials are optimistic for the non-fork starts: the office now also holds the live thread's later answer, which `history` can find.
- A third prompt wording that tells the agent to answer from its context when the result is there still sent the fork to `history` 9 times in 10; offering the tool makes the agent verify.

### Session of a reply root

Both run-answer log sites hold the run's message: `ProgressiveRenderer` platforms receive it in their context factory, and the Slack lifecycle holds the event and `sessionPlan`. Logging `replyTo` (trigger ID) and `sessionKey` there names the session directly, so a Telegram or Discord reply root needs no adapter-specific key derivation. The same `sessionKey` lets chat sync keep a Discord thread reply out of the channel session.

## Round 5: where the fork lives

Both candidates give the thread the same model context; they differ in where it is stored.

- **B1**: the thread is a pi-durable conversation forked inside the channel's storage.
- **B2**: the thread keeps its own storage, filled with a copy of the fork's context.

### B1 at the pi-durable level

A channel conversation and a thread forked from it, in one JSONL storage, each submitted input at once with a 300 ms tool:

- Both finished in 341 ms, and their tool calls overlapped: the Harness runs them concurrently.
- With one extension per conversation (`agent.extensions` at `root()` and `fork()`), each tool call ran its own conversation's closure and hook, and `env()` received each conversation's ID.

So mikan's per-run tool binding can stay as it is, if each conversation selects its own extension instead of the storage's root selecting one. pi-durable needs no workaround.

### B1 in mikan

What assumes one conversation per storage today:

| Area                | Today                                                                                            | Under B1                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `SessionStore`      | Opens one Harness and its root per file, with an exclusive writer lease                          | One shared Harness per channel storage, handed out per conversation, closed by the last user |
| `MikanAgentSession` | Installs the `mikan` extension and configures `root`                                             | Installs an extension per conversation and configures that conversation                      |
| Session files       | A thread is `<suffix>.jsonl` beside its own `.durable`                                           | A thread is an index pointing at a conversation in the channel's storage                     |
| Callers             | 20 production call sites of `SessionStore.open/create/inspect`, 18 files keyed by a session path | Each resolves a session to a storage and a conversation                                      |
| Existing threads    | Own storages                                                                                     | Imported into their parent storages by a migration, or kept in two layouts                   |
| Failure scope       | One corrupt storage loses one session                                                            | A corrupt channel storage loses the channel and all its threads                              |

### B2 in mikan

- One function: snapshot the channel storage, fork at the cause run's last entry, read `context()`, and append its messages to the new thread storage. It is the import step `mikan migrate` already performs (`importSession` in `src/migrations/sessions-durable.ts`).
- No layout, lease, or caller changes.
- Storage cost: the inherited prefix is stored once per thread (about 0.45 MB at the QA channel's size).

### Against the bar

|              | B1                                                                                                                                        | B2                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Maintainable | Removes the copy, but adds a shared Harness, conversation-keyed sessions, a thread index, and a migration                                 | One function beside the existing importer; nothing else moves                        |
| Trade-offs   | 37.6 MB for 500 threads; channel open and snapshot grow with threads (263 ms and 190 ms at 500); one storage failure reaches every thread | About 225 MB for 500 threads; about 100 ms per new thread; failures stay per session |
| Built on Pi  | Native fork by reference, per-conversation extensions                                                                                     | Native fork in a snapshot, then mikan's own copy                                     |

## Round 6: handing sessions to pi-durable

The bar now ranks building on Pi first, so this round asks what pi-durable can own if a thread is a conversation in a shared storage (B1).

### What pi-durable already provides

| mikan mechanism today                                                                           | pi-durable counterpart                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Header file per session with `parentSessionId`                                                  | `ConversationRecord.parent` (`conversationId`, `at`)                    |
| Parent found by the main session current at the thread's time (`resolveParentSessionForThread`) | The fork's `parent.at` entry                                            |
| Session listing by directory scan (`listOfficeSessions`)                                        | `scanConversations`                                                     |
| `/new`: a new main file, the `current` pointer, `scoped-archive-*` for threads                  | `Conversation.reset(handoff)`: a `head` cut; raw history stays readable |
| Thread file named by session key                                                                | A session document family keyed by session key                          |
| Name and run record in `mikan.session`                                                          | Unchanged: a conversation document                                      |
| Read-only snapshot copy for `history` and the session view                                      | Reads through the live Harness, in the process that owns it             |

### Storage scale, JSONL against SQLite

The same B1 storage (a 300-entry channel plus N threads of 40 entries), opened with each backend that pi-durable ships. Heap is measured after opening.

| Threads | JSONL size | JSONL open | JSONL heap | SQLite size | SQLite open | SQLite heap |
| ------- | ---------- | ---------- | ---------- | ----------- | ----------- | ----------- |
| 50      | 4.2 MB     | 33 ms      | 23 MB      | 5.0 MB      | 1 ms        | 13 MB       |
| 500     | 37.6 MB    | 260 ms     | 103 MB     | 43.2 MB     | under 1 ms  | 13 MB       |
| 2,000   | 148.8 MB   | 1,015 ms   | 365 MB     | 170.9 MB    | 1 ms        | 13 MB       |

- JSONL decodes the whole storage into memory on open, so one long-lived storage per channel costs memory and open time in proportion to its history.
- SQLite opens in constant time and memory; a thread's `context()` stays at 1–2 ms.
- SQLite uses Node's built-in `node:sqlite`, so it adds no dependency, but Node 24 still prints an `ExperimentalWarning` for it.

### Production scale

Read-only counts of the production State dir, still in the v4 session format, covering about 27 days of files (no names or contents read):

| Measure                    | Value                                   |
| -------------------------- | --------------------------------------- |
| Offices                    | 188 (186 Slack, 2 GitHub)               |
| Main sessions              | 591                                     |
| Thread sessions            | 11,276                                  |
| Session data               | 3.6 GB, 5.9 million lines               |
| Largest office             | 344.7 MB: 11 main sessions, 249 threads |
| Most threads in one office | 329                                     |
| Largest single thread      | about 80,700 lines                      |

- One office gains up to about 330 threads and 345 MB a month. A JSONL storage that size would decode into memory on every open (extrapolating the table above: seconds and gigabytes), so B1 is viable only on SQLite.
- B2 copies the inherited context into every thread. With 11,276 threads a month, even 0.5 MB each adds about 5.6 GB a month, more than all session data today.

## Round 7: running B1

### Runtime lifetime today

`SessionLifecycle` keeps one runner per session key, evicting idle ones after a timeout and above a session cap; each runner opens its own `SessionStore` (and writer lease) and closes it on dispose. Under B1 the runners of one office share a storage, so the storage is opened by the first runner and closed after the last; the Harness is the single writer that pi-durable requires.

### Recovery across conversations

A thread stopped mid-tool by a process exit; after reopening, the channel submitted input (SQLite storage, faux model):

| Reopen                                                                    | Thread afterwards                                                                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Submit at once                                                            | Its run resumed headless: the interrupted call got an `interrupted` result, then a new model request produced an answer that no runner presents |
| `inspect()`, then `abortTask()` for each ownerless live task, then submit | Its call got an `aborted` result; no further request                                                                                            |

Scheduling is per storage: the first `submit()` resumes every conversation's unfinished work. The rule mikan applies per session today (abort an unfinished run before the next prompt) becomes one step at storage open, through public API.

### One extension per conversation

`Registry.install` replaces an extension of the same name in place and `uninstall` removes it. A conversation stores only extension names; a forked or new conversation selects the Harness default (every installed extension) until it is configured, so the shared Harness should set `settings.extensions` to an empty list and each runner should configure its own conversation, as `MikanAgentSession` does for the root today.

### Migration into one storage per office

Importing every session of the QA office (33 sessions: the current main, earlier mains, and threads; visible context only) into one SQLite storage, with a session-scoped document family indexing session keys to conversations:

| Measure                                     | Value                        |
| ------------------------------------------- | ---------------------------- |
| Messages imported                           | 2,112                        |
| Time, including reading each source         | 190 ms (0.09 ms per message) |
| Source (durable JSONL)                      | 4.0 MB                       |
| Result (SQLite)                             | 1.5 MB                       |
| Conversations listed by `scanConversations` | 33                           |

At this rate the production line count (5.9 million, an upper bound on visible messages) imports in under ten minutes. Imported threads have no pi-durable parent, because their storages hold a seed, not a fork point.

Production still runs the v4 format. Releasing the per-session JSONL format first would add a second migration of the same data.

### `node:sqlite`

Production runs Node 24.13, where `node:sqlite` is at stability 1.1 (active development); Node 24.15 raises it to 1.2 (release candidate). It prints an `ExperimentalWarning` on load.

## Round 8: v4 straight to SQLite

A POC migration reads each v4 session with the existing v4 reader and writes it, with the same import rules as `0009-sessions-durable` (visible context, bookkeeping entries, interrupted calls closed, name), into one SQLite storage per office: the current main session as the root, every other session as an ownerless conversation, and a session-scoped index from session key to conversation and its original session ID. It then compares each session's model context with what `0009-sessions-durable` produces for the same file.

| Measure                           | Per-session JSONL (`0009`) | One SQLite per office              |
| --------------------------------- | -------------------------- | ---------------------------------- |
| Local v4 copy                     | 2 offices, 51 sessions     | same                               |
| Time                              | 459 ms                     | 179 ms                             |
| Size                              | 25.4 MB of v4 in           | 2.8 MB out                         |
| Model context, session by session | baseline                   | 51 of 51 identical, 2,077 messages |

### Production dry run

A read-only pass over the production State dir with the v4 reader and the same import rules, writing nothing, on Node 24.13:

| Measure                                | Value                                                      |
| -------------------------------------- | ---------------------------------------------------------- |
| Offices                                | 188; 6 without a `current` pointer                         |
| v4 sessions                            | 11,867: 182 current main, 445 earlier main, 11,240 threads |
| Read failures, non-v4 files, open runs | 0, 0, 0                                                    |
| Branch entries read                    | 544,665                                                    |
| Messages to import (visible context)   | 401,493                                                    |
| Interrupted tool calls to close        | 21                                                         |
| Bookkeeping entries                    | 16,540                                                     |
| Sessions with a compaction             | 74                                                         |
| Largest office                         | 260 sessions, 46,381 messages                              |
| Largest session                        | 4,283 messages                                             |
| Read time                              | 65 s                                                       |
| Peak memory (RSS)                      | 547 MB                                                     |
| Free disk                              | 105 GB                                                     |

Visible context is about a fifteenth of the raw lines, so the import writes far less than the 3.6 GB it reads. At the local write rate (0.09 ms per message) the writes add well under a minute to the 65 s read. An office without a `current` pointer gets an empty root, and its sessions become conversations.

### Production trial

The same POC on a copy of the production sessions (copied into a private trial directory in 24 s, deleted afterwards), on Node 24.13. Each office was migrated both ways and compared session by session:

| Measure                         | Per-session JSONL (`0009`) | One SQLite per office            |
| ------------------------------- | -------------------------- | -------------------------------- |
| Offices, sessions               | 188, 11,867                | same                             |
| Migration time                  | 293 s                      | 128 s                            |
| Output                          | 11,867 storage directories | 188 database files, 1.58 GB      |
| Messages in model context       | 401,493                    | 401,493                          |
| Sessions with identical context | baseline                   | 11,849 of 11,867                 |
| Peak memory (RSS)               | —                          | 956 MB, including the comparison |

- All 18 differing sessions differ only in the `timestamp` of the error result that closes an interrupted tool call: the importer stamps it with the time of import, so two runs differ. Every other message is identical. Stamping the placeholder with its call's timestamp would make the import deterministic.
- 6 offices had no `current` pointer and got an empty root; `scanConversations` listed every imported conversation in all 188 offices.
- The 128 s include reading every v4 file, so they bound the downtime of the session step.

## Round 9: which conversation a request belongs to

`MikanAgentSession` wraps the Harness's `Models` to add the session ID (prompt cache key and session affinity), to skip a request once a run's budget is spent, and to count and log requests. With one Harness per storage, that wrapper served one session. Shared, it must tell conversations apart, and pi-durable passes no conversation to `Models`:

| Probe                                                                                                          | Result                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Arguments of `streamSimple`                                                                                    | The model, the messages, and `{ signal }`: no conversation                             |
| `signal` from a hook                                                                                           | Not on the public `HookApi`                                                            |
| Throw from `beforeRequest`                                                                                     | Reported; the request is still sent                                                    |
| Await `abort()` from `beforeRequest`                                                                           | Deadlock: the abort waits for the hook                                                 |
| Fire `abort()` from `beforeRequest`                                                                            | The run aborts, but the request is already sent                                        |
| Return the messages from `beforeRequest` with a copied last message, and look that object up in `streamSimple` | 20 concurrent requests from two conversations, each attributed to its own conversation |

`beforeRequest` may replace a request's messages, and generation hands the returned message objects to `Models.streamSimple`. A conversation's own extension tags its request this way, so the shared wrapper keeps per-session IDs, budgets, and counts exactly as today. That relies on generation passing message objects through without copying them, which is not a documented contract, so a test must pin it and the README must name it as a local exception until pi-durable passes conversation-scoped request options.

Compaction summaries are built inside the compaction task, with no hook over their messages. Their requests use `cacheRetention: "none"`; a conversation's `beforeCompact` hook counts them and declines a compaction once the run's budget is spent.

## Open

1. Whether the production provider reuses the cached prefix across session IDs.
2. Whether to upgrade production Node to 24.15 or later before adopting `node:sqlite`.
3. Whether to hold the per-session JSONL release so production migrates once.
