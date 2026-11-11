# Migrating to Pi 1.5

Status: implemented 2026-11-11. Tracks issue #203.

## Why

Pi ships breaking changes in minor releases. mikan asked for `^1.3.0`, the lockfile tested 1.3.0, and a clean `npm install -g` resolved 1.5.2 and failed to start. The six Pi packages were pinned to exact 1.3.0 first; this change moves the pin to 1.5.2.

## What changed upstream, and what it means here

Sources: the changelogs of `chord`, `pi-durable`, and `pi-env` 1.4.0 to 1.5.2, and the type declarations of all six packages at 1.5.2. `pi-ai`, `pi-codemode`, and `pi-mcp` ship no changelog, so their changes were found by compiling and running the test suite. `pi-env`'s one breaking change, to `RemoteWatcher`, touches nothing mikan calls; neither do `afterTool` running on error results nor `onReport`'s new argument, which mikan does not use.

| Upstream change                                                                                                                                                                                                                               | Effect on mikan                                                        | Answer                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The chord root exports Chord v2; `JsonValue` and `copyJson` move to `/json`, `Context` to `/context` (1.5.1)                                                                                                                                  | 8 imports fail                                                         | Import from the subpaths                                                                                                                                                                    |
| `watchEvents()` and its event types are removed; a client renders the conversation view (1.5.0)                                                                                                                                               | The run path in `harness/session.ts` consumed 17 event types           | Derive `HarnessEvent` from `Conversation.watch()`; see below                                                                                                                                |
| `defineDoc()` requires `checkpointWhen` (1.4.0)                                                                                                                                                                                               | `SessionDoc`, `SessionIndexDoc` fail to compile                        | `() => false`, which is what an absent predicate did in 1.3.0                                                                                                                               |
| The Harness wraps `models` with a client identity when it opens, reading `getAuth` at once (1.5.0)                                                                                                                                            | 230 tests fail: the lazy models proxy throws before a session is bound | Pass `models` as a function, which `HarnessOptions` accepts and resolves at each use                                                                                                        |
| `Conversation.viewState()` is removed (1.5.0)                                                                                                                                                                                                 | One reader of the conversation's owner                                 | `Conversation.watch()`, read `value`, stop                                                                                                                                                  |
| Tool schemas are JSON Schema typed through pi-schema; TypeBox is no longer a Pi dependency (1.5.0)                                                                                                                                            | None at runtime: TypeBox schemas are JSON Schema and still validate    | Keep TypeBox, already a direct dependency at an exact version                                                                                                                               |
| The Harness gives every model request a default client identity: a `User-Agent` of `pi/<version> (<platform>; <runtime>; <arch>)`, and for OpenRouter `HTTP-Referer: https://pi.dev` and `X-OpenRouter-Title: pi` (1.5.0). 1.3.0 sent neither | mikan's requests would be attributed to Pi                             | `identity: { attribution: null }`: no attribution headers, as before. The `User-Agent` cannot be turned off and stays Pi's; it names the platform and architecture, no deployment or person |
| SQLite storage migrates to schema version 2 on open; `pi.live` is version 3, `pi.tool` 3, `pi.generation` 2 (1.4.0, 1.5.0)                                                                                                                    | A state directory opened by this version cannot be opened by 1.3.0     | Accepted: the upgrade is one-way. Back up the state directory before upgrading a deployment                                                                                                 |
| A run can end `unanswered` for `turn_limit`, `nothing_to_answer`, `interrupted`, `restart_limit` (1.5.0)                                                                                                                                      | `drive()` names only `aborted` and `model_error`                       | Unchanged: any other reason throws `Pi run failed: <reason>`, as unknown reasons did before                                                                                                 |
| A task cut off `restartLimit` times ends instead of parking (1.5.0)                                                                                                                                                                           | A crash-looping run ends with a failure instead of staying busy        | Accepted                                                                                                                                                                                    |
| Partial answers are stored up to 1 s after they are shown (1.5.0)                                                                                                                                                                             | A crash loses up to 1 s of streamed text instead of 100 ms             | Accepted; watches still see each partial at once                                                                                                                                            |

## Deriving run events from the view

Pi folds every commit made while a watch listener runs into its next call, and mikan's listeners await platform calls, so a listener sees an arbitrary subset of intermediate states. The rule that follows:

- What is finished comes from the transcript, by entry ID, seeded from the view at attach. A new entry gives `message_end`; a tool result entry gives `tool_execution_end`.
- When the view's window (50 to 100 entries) has moved past the last entry seen, the missed entries are read from `Conversation.entries()`.
- `pi.live` gives previews only: the streamed answer, tool `details`, retries, compactions.
- The run's end is not a transition. After the submission settles, the session takes a fresh view, applies it, and waits for idle while `pi.live.run` is present.

### Experiment: a listener slower than the run

60 tool rounds, with the listener blocked on its first event until the last tool has run. 122 messages are committed.

| Implementation                                         | `message_end` events delivered |
| ------------------------------------------------------ | ------------------------------ |
| Pi 1.3.0, `watchEvents()` (`main` before this change)  | 22 of 122                      |
| Pi 1.5.2, view entries only, no read of missed entries | 73 of 122                      |
| Pi 1.5.2, as implemented                               | 122 of 122                     |

The first row is a defect that predates this change: past 100 pending commits the old event stream replaced its backlog with a snapshot, so a long run behind slow platform calls lost messages. The test `a listener slower than the run still gets every message and tool call, in order` keeps the third row.

### Experiment: the events each run presents

Every test that drives a session ran on the commit before this change and on this one, with `MikanAgentSession.emit` recording each event. Timestamps and temporary paths were masked and consecutive `text_delta` events joined, because how an answer is cut into deltas depends on timing.

| Result                          | Tests      | What differs                                                                                                                                                    |
| ------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identical sequence              | 128 of 145 | Nothing. Includes runs with host history writes, queued messages, parallel tools, compaction, and aborts                                                        |
| One more `tool_execution_start` | 11         | After a restart, a tool call that was running is presented as started again before its `interrupted` result. Before, the result arrived with no start. Accepted |
| Same events, different order    | 4          | `auto_retry_start` comes after the failed answer's `message_end` instead of before its `message_start`. Accepted                                                |
| Nested calls presented again    | 1          | After a restart, a codemode script's finished nested calls are presented once more when the session attaches. Accepted                                          |
| More events                     | 1          | The slow listener case above                                                                                                                                    |

### Alternatives

| Option                                                                       | Why not                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Stay on Pi 1.3.0                                                             | No upstream fixes, and every clean install depends on the pin holding                                                            |
| Render `pi.live` directly in the platform presenters and drop `HarnessEvent` | `HarnessEvent` is exported from the package and four modules consume it; replacing it is a larger change than this upgrade needs |
| Rebuild events from the watch's operations                                   | They carry the same deltas, but folding joins them, so order and boundaries between commits are lost                             |

The follower is local code where Pi has no public hook for "tell me what finished". It is removed if Pi offers one, or when the presenters render the view.

## Acceptance eval

The reference Slack eval (`.pi/skills/mikan-acceptance-eval/references`), run through `SlackMessagingBot` with a fake Socket Mode connection and Pi's faux provider. The upgrade case reads a state directory that `main` on Pi 1.3.0 wrote.

| Case                                      | Pi 1.3.0                  | Expected   | Pi 1.5.2   |
| ----------------------------------------- | ------------------------- | ---------- | ---------- |
| E1 task status while one runs             | 1/3 correct, 3 listed     | same       | same       |
| E2 status after restart                   | 1/3 correct, 3 listed     | same       | same       |
| E3 thread status shortcut                 | replied, 0 model calls    | same       | same       |
| E4 status and shortcut after log loss     | 1/3 correct; replied      | same       | same       |
| E5 legacy task status and shortcut        | 0/1 found; model answered | same       | same       |
| E6 thread status with a 50 MB log, median | 146 ms                    | within 10% | 145 ms     |
| E7 upgrade: state written by 1.3.0        | both tasks found, replied | same       | same       |
| Slow listener, 60 tool rounds             | 22 of 122 messages        | 122 of 122 | 122 of 122 |
| Unit and integration suite                | 1925 pass                 | all pass   | 1926 pass  |
| Clean global install starts               | only with the pin         | starts     | starts     |

## Not verified

- A run on a real platform with a local daemon, and the Slack E2E workflow. Both need the owner's approval.
- A production-sized state directory opened by 1.5.2. E7 and the migration tests cover small ones.
- `auto_retry_start.attempt` now reports `pi.live.generation.attempt`. The retry tests pass, but the numbering against a real provider error was not compared.
