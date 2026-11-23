# The session core against pi-durable 1.5.2 (2026-11)

The [codebase survey](codebase-survey-2026-11.md) named the session core as the place a robust core is decided: about 5,600 lines in `src/sessions`, `src/harness/session.ts`, `src/harness/runner.ts`, `src/harness/presenter.ts`, and `src/runtime`. This page asks which of it restates what pi-durable already offers through its public interface.

Method: each file was broken into responsibilities, and each was compared with the declarations and documents the Pi packages export at the installed version. A responsibility counts as replaceable only when the Pi export is in the package's `exports` map.

## Finding

No large part restates Pi. Fork, reset, abort, compaction, recovery, and usage are already Pi's; what mikan keeps is office paths, platform history, routing a request to its conversation's models and environment, budgets Pi does not have, and presentation. What could go is small, and falls in three groups.

### State written and never read (removed with this page)

| What                                                            | Evidence                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The run record: `recordRun`, the `run` field of `mikan.session` | Written at the start and the end of every run, two commits; its one reader was called only by tests. It fed the task status removed by ADR 0032. |
| `auto_retry_end` and `tool_execution_update` events             | Emitted to subscribers; the presenter's switch drops both and nothing else subscribes.                                                           |

About seventy lines of production code and two storage commits a run. `SessionStore.inspectExecution` now reports only whether Pi has a run open. A storage written earlier keeps its `run` field, which nothing reads.

### A Pi export does the same job (not done; each is under thirty lines)

| mikan                                                         | Pi export                                                | What would differ                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry and compaction defaults merged by hand                  | `DEFAULT_RETRY_POLICY`; Pi merges partial settings       | Nothing known.                                                                                                                                                        |
| A getter object forwarding six settings to the shared harness | `HarnessOptions.settings` accepts a function             | Every bound field would be forwarded, not six.                                                                                                                        |
| `ownerOf` opens a watch to read a conversation's owner        | `tx.conversation(id).owner`                              | Nothing known.                                                                                                                                                        |
| The LLM call limit of an event run                            | `AgentState.maxTurns`                                    | Counts tool rounds, not requests; the run ends `unanswered`, and the person sees a different notice at the limit.                                                     |
| The marker of the request in flight, for the abort log        | `GenerationHooks.beforeProviderRequest`, `afterResponse` | `afterResponse` is skipped for a deferred response.                                                                                                                   |
| 100 ms poll for the parent session to finish                  | `Conversation.waitForIdle`                               | Nothing known.                                                                                                                                                        |
| Spans and metrics for model and tool calls                    | `HarnessOptions.telemetry`                               | Pi's names differ from the ones ADR 0007 fixes, and Pi puts provider error text in span status, which that ADR forbids; an adapter would have to translate and strip. |

None is verified by an experiment. The first three change no behaviour and are worth doing together when that code is next touched; the rest change what a person or an operator sees and need the design steps.

### Possibly unnecessary (needs a measurement)

| What                                                                     | Size      | The measurement                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matching a bot's log record to a session message by its text             | about 75  | Replay copies of real logs and count how often the match is taken. Every adapter now logs an answer with its session key, which is skipped earlier.                                                                                     |
| The runner cache: generations, deferred clears, idle and cap eviction    | about 110 | The cost of building a runner for each message: storage open, MCP connection.                                                                                                                                                           |
| Importing the last fourteen days or two hundred messages into a session  | about 35  | The acceptance eval without the window, then with the `history` tool alone.                                                                                                                                                             |
| Rebuilding the tool checklist from events instead of rendering Pi's view | about 270 | A prototype outside `src/` that renders the checklist from a recorded run's view. The reason recorded for keeping the follower, that run events were a package export, lapsed when the package stopped publishing a module entry point. |

### One drift found

`src/harness/session.ts` recomputes a response's total tokens from four components, while Pi adds the provider's own total. A provider whose total differs from that sum makes mikan's count and Pi's usage document disagree. Not changed here; it needs a copy of real usage to see whether any provider in use differs.

## What this means for the goal

The session core is not where the code is. All of the above together is about six hundred lines of 37,600, most of it conditional on a measurement. The code that can leave in quantity is the three portals the survey could not measure, and they are decided by counts from a release.
