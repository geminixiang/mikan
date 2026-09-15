# Conversation-to-task handoff: implementation investigation

## Objective and evidence boundary

Goal: let an agent turn a conversation request into independent work without blocking subsequent conversation. Thread layout is secondary to execution ownership and control.

Investigation date: 2026-09-15. Source baseline: `36ac8af` (package version beta.60). No feature implementation or production deployment was performed.

Evidence levels:

- Static inspection of application source, existing regression tests, and the installed Pi implementation.
- Ten additional deterministic local simulations using real Slack adapter intake/queues, ConversationRuntime, runner, Pi harness and session files. Slack transport and model are test doubles; long work is a deferred tool, not an actual slow external service. Native steering is separately exercised directly through Pi's lane interface, not a mikan feature.
- Authorized live Slack testing in the `geminixiang` workspace, with browser-submitted human messages, real Socket Mode delivery, the configured `macmini/gpt-5.6-terra` model and Docker-backed native bash. These are local-daemon E2E observations, not production observations.
- Twelve relevant test files / 261 tests passed, including the ten temporary investigation tests. The investigation test file was archived outside the worktree, not added to the permanent suite.

## Source map and actual ownership

| Concern               | Source                                                                                                          | Relevant behavior                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack intake          | `src/adapters/slack/bot.ts`: `handleAppMention`, `handleMessageEvent`, `processSlackMessageIntake`              | Mentions and DMs trigger; shared-channel bare thread replies return before shared intake.                                                                                    |
| Slack queues          | `src/adapters/slack/bot.ts`: `resolveQueueKey`, `enqueueEvent`; `src/adapters/shared.ts`: `MessagingEventQueue` | Unknown threads may enter the channel queue. Event anchor creation queues actual work on the scoped queue and returns without awaiting that work.                            |
| Shared intake         | `src/adapters/intake.ts`                                                                                        | Magic word precedes trigger policy inside this function, but cannot catch events already dropped by the Slack adapter.                                                       |
| Runtime serialization | `src/runtime/conversation-runtime.ts`; `src/runtime/session-lifecycle.ts`                                       | Runs serialize per office/session key. Different scoped sessions can overlap. Office maintenance waits for active office work.                                               |
| Agent execution       | `src/harness/runner.ts`; `src/harness/session.ts`                                                               | `run` awaits the whole Pi operation and presentation. Tools bind once per run to actor, responder and thread context.                                                        |
| Presentation          | `src/harness/presenter.ts`; `src/adapters/slack/response-lifecycle.ts`                                          | Tool progress replaces the primary response. Event `initialMessageTs` updates the anchor. Thread replies can use native streaming.                                           |
| History               | `src/sessions/chat-history-sync.ts`; `src/sessions/store.ts`                                                    | Ordinary threads bootstrap bounded platform history. Pre-registered event threads intentionally skip bootstrap. Parent linkage is not full parent transcript inheritance.    |
| Persistence           | `src/sessions/session-store.ts`                                                                                 | Cached runner retains its writer after run settlement. Different session files have independent writers. MCP connections belong to each store lifetime.                      |
| Background event      | `src/harness/tools/event.ts`; `src/events/index.ts`; `src/events/watcher.ts`                                    | Writes a self-contained future task; watcher delivers and deletes one-time event on enqueue, not completion.                                                                 |
| Subagents             | `src/harness/subagent.ts`; `src/harness/tools/subagent.ts`                                                      | In-memory sessions, explicit grants, bounded parent-reference context, awaited tool completion, parent cancellation/usage ownership. Not an independent conversational task. |
| Execution isolation   | `src/harness/execution-resolver.ts`; `src/sandbox/identity.ts`                                                  | Office-scoped image sandbox and workspace are shared by thread sessions. Session isolation does not isolate filesystem effects.                                              |
| Shutdown              | `src/main.ts`; `src/process-lifecycle.ts`                                                                       | Stops intake/watchers, drains adapter queues, then runtime; drain deadline requests runtime cancellation.                                                                    |
| Existing controls     | `src/runtime/conversation-runtime.ts`, `src/adapters/shared.ts`, Slack Running Tasks UI                         | Runtime exposes running sessions and current tool; stop selects current session, then parent, and sometimes only running scoped session.                                     |

## Deterministic simulation results

All ten tests passed as assertions of CURRENT behavior, including undesirable behavior. Passing does not mean a proposed handoff feature exists.

| ID  | Scenario                                                              | Observed behavior                                                                                                                                                       |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Long tool in channel session; unrelated second message                | Second model request starts only after long tool and first turn finish.                                                                                                 |
| S2  | Immediate event running long tool; unrelated channel question         | Channel answer completes while event tool remains blocked. Final event answer updates anchor, not a new thread reply.                                                   |
| S3  | Shared-channel bare thread correction and bare `stop`                 | Both are logged but do not enter shared intake. Mentioned `stop` aborts the running scoped session.                                                                     |
| S4  | Mentioned correction queued behind active task; then stop             | Active task aborts, but the queued correction subsequently executes. Stop is not queue cancellation.                                                                    |
| S5  | Anchor post fails asynchronously                                      | `enqueueEvent()` already returned true; no model run starts. Acceptance is not confirmed delivery.                                                                      |
| S6  | Root `/new` while independent task runs; then ordinary question       | Office maintenance waits for the task, holding subsequent channel work. Nonblocking task execution does not make every command nonblocking.                             |
| S7  | Proposed continuation reuses original message ID                      | History cutoff excludes the original request and later acknowledgement from bootstrap. Thread root seed exists separately; internal parent transcript is not inherited. |
| S8  | A terminating handoff tool and another effect tool in one model batch | Other effect still executes, and a further model round occurs. `terminate: true` is not a pre-execution batch barrier.                                                  |
| S9  | Native Pi steering while a tool is gated                              | Queuing steering succeeds; next model context receives it after tool completes. It does not interrupt the active effect.                                                |
| S10 | Anchor succeeds; runner setup fails                                   | Anchor remains `Working on it...`; failure is logged/reported, without a replacement failure reply on that path.                                                        |

The temporary tests call private adapter methods to inject SDK-normalized messages; network transport is not simulated end-to-end. They use public runtime execution for the actual agent run. S9 uses a direct native lane because mikan does not expose steering.

## Live Slack observations

Workspace: `T0B4DDYBVB3` (`geminixiang`). DM: `D0B4BL40DAN`. Shared test channel: `C0B4BL9AB6W` (`qa-mama-test`). All times below are Taiwan time (UTC+8).

Local preflight found no running local mikan daemon. Bot `auth.test` matched the intended workspace. A fresh private temporary state/workspace was used. Socket intake and local run logs confirmed that the test daemon handled the test messages; this is stronger evidence than merely observing a Slack reply, though it is not an inventory of unknown remote connections.

### A. Baseline: direct long work blocks the conversation

- 09:15:56: request A starts.
- 09:15:59: native bash starts `sleep 45`.
- 09:16:16.817: independent request B posted and logged.
- 09:16:44: bash completes.
- 09:16:48: request B starts its run.
- 09:16:52.164: B reply posted.

B waited about 35.35 seconds from Slack submission to visible reply, most of it behind A.

Evidence: [request A](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789434955926779), [request B](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789434976817579), [reply B](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435012164069).

### B. Explicit immediate event frees the conversation

The request explicitly instructed the model to create an immediate event and finish the parent turn.

- 09:17:18: event tool writes event; watcher deletes it after enqueue.
- 09:17:22: separate event session starts.
- 09:17:25: event native bash starts `sleep 60`.
- 09:17:37.117: independent request B posted.
- 09:17:39.900: B reply posted, approximately 2.78 seconds later.
- 09:18:25: event bash completes.

The independent answer arrives about 45 seconds before the task tool completes. This verifies existing nonblocking execution, not autonomous routing selection.

Evidence: [event request](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435034081909), [event anchor](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435042104379), [independent answer](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435059900289).

### C. A correction in the DM task thread arrives too late for the current operation

- 09:18:06.750: correction posted under the event anchor, asking for `EVENT_CORRECTED` instead of `EVENT_WORK_DONE`.
- 09:18:25: original task tool completes.
- Original task still delivers `EVENT_WORK_DONE`.
- 09:18:29: correction starts as a new run.
- 09:18:33.339: `EVENT_CORRECTED` delivered as a separate thread reply.

The correction was received while the task was active but was queued as a later turn, not incorporated into its current model context.

Evidence: [correction](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435086750329), [later reply](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435113339779).

### D. Natural phrasing can select existing event delegation, but evidence is limited

User text asked for a 45-second wait and said they wanted to continue asking other things, without naming event or a tool.

- Model selected immediate event and acknowledged the work.
- Task bash ran 09:19:09–approximately 09:19:54.
- Independent question posted 09:19:32.480; reply posted 09:19:35.322, about 2.84 seconds later.

Important limitation: this was the SAME DM after an explicit event example. The model had a recent demonstration. It is not a fresh-session autonomy benchmark, nor evidence for coding, browser, research or arbitrary skill tasks.

The acknowledgement also claimed the wait had started before the task's bash actually began. Starting/queued language matters even when the pipeline works.

Evidence: [natural request](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435130248929), [independent reply](https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789435175322249).

### E. Shared-channel bare thread stop does not reach the control path

A direct top-level mentioned task executed `sleep 60`. Its user-message thread received:

- 09:21:11.396: bare `stop`; it was logged, but task continued.
- 09:21:35.504: mentioned `@mikan stop`.
- 09:21:36: tool reported `Command aborted`.

A final browser readback still showed `Stopping…` after the tool had reported cancellation. Cancellation of work is therefore verified, but successful final stop-notice settlement is not; the stale notice requires separate diagnosis.

This live case targets the top-level task through a reply to its user-message root. Exact scoped-event stop was additionally covered by S3. Do not conflate the two.

Evidence: [root](https://geminixiang.slack.com/archives/C0B4BL9AB6W/p1789435233336179), [bare stop](https://geminixiang.slack.com/archives/C0B4BL9AB6W/p1789435271396399), [mentioned stop](https://geminixiang.slack.com/archives/C0B4BL9AB6W/p1789435295504769).

## Important design corrections

1. Existing background execution works. Reuse the scoped-run dispatch pattern instead of adding an independent runner/scheduler by default.
2. A text-only `start_task(message)` proposal does not specify enough task context. Current events explicitly require a self-contained task. Preserve request, constraints, actor identity and attachment references; do not confuse public acknowledgement with execution input.
3. A terminating tool is not a reliable guarantee that expensive sibling calls cannot run. Any strict handoff protocol needs a tested batch/admission rule, not only a prompt instruction.
4. A callback awaiting a child run can deadlock with parent-bootstrap waiting or retain the channel queue. Admission must be bounded and distinct from completion.
5. Event anchors bind a scoped session while `event.thread_ts` remains absent. Responder layout, `ConversationMessage.threadTs` and platform tool-pack binding are not automatically equivalent to session key identity. A true threaded task must align them, especially for `slack_blockkit` and file upload.

## Recommended planning boundary

Do not implement a new generic TaskStore, restrict all main-conversation tools or serialize every office task solely on the basis of this investigation.

Plan the feature around three existing mechanisms:

- **Delivery:** reuse the event anchor/scoped queue pattern, but provide a confirmed handoff identity and a visible failure when admission fails. Decide whether to extend event delivery or add a small conversation-specific entry point; do not change all scheduled reminder semantics incidentally.
- **Interaction:** first make target selection and stopping correct. Then expose native steering for same-task input with actor/attachment handling and history deduplication. Steering must not silently retain the original user's authorization for another user's request. Unrelated questions remain independent main-conversation turns.
- **Presentation/history:** retain acknowledgement as anchor; route actual task output into its thread; record source-to-task association in existing persistence where practical. Explicitly define how main-conversation followups obtain task status/result rather than assuming thread history is automatically synchronized back.

Before selecting a final interface, validate a fresh-context model matrix (short answer, multi-step investigation, edit/test, long skill, ambiguous task reference), a mixed-tool-batch handoff, two concurrent tasks plus ambiguous stop, and failure/restart at each admission boundary. Native steering alone does not satisfy independent conversation, and a task thread alone does not satisfy task control.

## Cleanup and local artifacts

The local daemon was shut down successfully at 09:22:46. The two sandbox containers created for this test were stopped, not deleted. No production daemon was stopped, upgraded or deployed. Test messages remain in Slack as evidence.

Private local evidence (not appropriate for content-bearing telemetry or public upload):

- `/tmp/mikan-task-live-LhUF8W/daemon.log`
- `/tmp/mikan-task-live-LhUF8W/slack-evidence.json`
- `/tmp/mikan-task-live-LhUF8W/workspace/` (isolated session/history files)
- `/tmp/mikan-task-investigation/task-flow-investigation.test.ts` (copy to `src/test/` temporarily to rerun)
- `/tmp/mikan-task-related-tests.log`

The temporary state directory also contains a private model configuration; do not attach or publish that directory wholesale.

## Follow-up: controllable task experiments (2026-09-15)

### Pi implementation distinction

The installed `pi-coding-agent` and mikan's `pi-agent-core` both report 0.85.1, but the coding-agent SDK constructs the low-level `Agent` and a coding-agent `SessionManager`. Mikan constructs a durable `AgentHarness` via its own `SessionStore`. These are not interchangeable session/control implementations.

Inspected installed coding-agent primary sources:

- `README.md`, complete `docs/sdk.md`, `docs/rpc.md`, `docs/session-format.md`.
- `examples/sdk/12-full-control.ts`.
- `dist/core/sdk.js`: constructs `new Agent`, binds provider and initial state.
- `dist/core/agent-session.js`: `steer`, `followUp`, `clearQueue`, `abort`, `_runAgentPrompt`, `_handlePostAgentRun`.
- `dist/modes/interactive/interactive-mode.js`: `clearAllQueues`, `restoreQueuedMessagesToEditor`.
- Installed core `dist/agent-loop.js`: tool-batch boundary and steering processing.

The coding-agent interactive Escape path clears session and compaction queues, restores their text into the editor, then aborts. Plain SDK `abort()` does not provide that same UI policy.

Mikan's native lane `requestOperationAbort` instead removes currently queued steering/follow-up inputs transactionally and returns their message payloads. Mikan currently discards these returned payloads. Native `nextRun` is a separate queue category and is not among those removed inputs.

### Nine additional executable experiments

These use real `MikanAgentSession`, `SessionStore`, native Pi execution, and (for C8/C9) real `ChatHistorySync`. Model responses and tool work are deterministic substitutes. Native lane access is test-only through the existing session internals: no production steering interface was added. C1 runs two independent MikanAgentSession instances, not a complete Slack/ConversationRuntime control implementation.

| ID  | Experiment                                                                             | Verified result                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Task tool gated; steering accepted; separate main conversation answers; task continues | Main answer occurs before task tool finishes. Steering has a native entry ID; committed user-message event and subsequent model context show adoption. Cancelling the ID afterwards returns `already_consumed`.      |
| C2  | Queue steering and follow-up; abort; close/reopen session; new constrained prompt      | Native abort returns both pending inputs. They do not reach next context. Original task history survives, and a new read-only constraint is present after reopening.                                                 |
| C3  | Abort a non-cooperative tool; enqueue steering after cancellation; repeat abort        | Late steering is accepted. Repeated abort returns no additional removed inputs. Late input reaches the next ordinary prompt. Admission must close when stopping begins.                                              |
| C4  | Add a test-only synchronous stopping flag before abort                                 | Late steering is rejected. Session remains active until the deliberately non-cooperative tool settles; only then can the UI truthfully say stopped. This validates a necessary guard, not a complete control module. |
| C5  | Parallel batch with one fast tool and one gated tool; steer after fast result          | Steering is observed only after the entire batch finishes, not after whichever tool finishes first.                                                                                                                  |
| C6  | Cancel an unconsumed steering entry by ID                                              | Native `cancelQueued` returns `cancelled`; the withdrawn instruction is absent from next model context.                                                                                                              |
| C7  | Call native `resume` after cancellation fully settles                                  | Returns `NothingToResume`. Continuing a stopped task is a new prompt on preserved history, not recovery of a suspended operation.                                                                                    |
| C8  | Adopt formatted steering, then sync its original platform log entry                    | Existing represented-message deduplication appends zero duplicate messages.                                                                                                                                          |
| C9  | Cancel unadopted steering, then perform normal platform log sync                       | Sync appends the cancelled input as a user-history message. Clearing queues alone does not prevent a cancelled instruction from returning to future model context.                                                   |

All nine experiments passed as assertions of the observed behaviors. Combined focused run: six test files / 104 tests passed. C3 and C9 deliberately demonstrate undesired behavior, not feature correctness.

### Actual coding-agent SDK comparison

`/tmp/mikan-coding-agent-control.mjs` imports the installed coding-agent SDK, uses a no-discovery ResourceLoader and temporary in-memory session, and substitutes only provider/auth and a gated tool. No external model/network work is intended by the test configuration.

Two cases were executed and asserted:

- Queue steering, then call SDK `abort()` without clearing: queued text appears in history and in an attempted provider call carrying an already-aborted signal.
- Queue steering, call `clearQueue()`, then abort: queued text is absent from history and that attempted provider context.

Both cases reached a second provider-adapter invocation with an already-aborted signal. The fake response factory is invoked before the fake provider checks that signal. This is NOT evidence of a second successful response, paid provider work, or real external execution. The experiment initially used provider-call count as a proxy and failed; it was corrected to inspect signal state, context membership, and settled history directly.

### Implications for the smallest useful implementation

1. **Do not import coding-agent as mikan's task runtime.** Reuse mikan's authorized runner and native lane; borrow coding-agent's clear distinction between accepted input, consumed input, and fully settled work.
2. **A task control entry point needs an admission gate.** Mark stopping synchronously, reject or explicitly retain later controls, request cancellation, and await task settlement before marking stopped. Do not mutate the session's actor-bound tool executor from a steering callback.
3. **Cancelled input needs a history disposition.** Preserve evidence that the user sent it, but prevent ordinary history sync from silently reintroducing it as an active instruction. A simple latest-timestamp watermark may also skip unrelated valid messages, so do not adopt that shortcut without ordering tests.
4. **Continue means a new turn with revised constraints.** Session identity and prior results are retained; the old tool operation is not resumed mid-effect. Distinguish this user action from Pi's crash-recovery `resume`.
5. **Minimum observable states are achievable without a dashboard.** Queued/consumed steering can use native entry identity and committed events. Stopping/stopped must follow actual settlement. “Consumed” means included in model context, not proof that the model complied with it.

Remaining unverified integration: an implemented Slack control interface; cross-user steering authorization; cancellation of both mikan's outer queues and native queues as one operation; crash/restart during stopping; delivery acknowledgements under Slack failure; real-model compliance with revised instructions. This round did not reconnect Slack or alter production. The preceding live Slack observations remain baseline behavior, not live verification of the new control experiments.

Additional local artifacts:

- `/tmp/mikan-task-investigation/task-control-experiment.test.ts`
- `/tmp/mikan-control-experiment-results.json`
- `/tmp/mikan-control-related-tests.log`
- `/tmp/mikan-coding-agent-control.mjs`
- `/tmp/mikan-coding-agent-control-results.json`

## Follow-up: native session v4 foundations

### Primary source scope

Inspected installed `pi-agent-core@0.85.1`:

- `dist/harness/session/types.d.ts`, `values.d.ts`, `session.d.ts`: entries, branch tips, lane configuration/inbox, operation states/results, application namespaces and mutation ownership.
- `dist/harness/session/jsonl/{types.d.ts,storage.js,repo.js}`: v4/storageVersion 1, transaction-line append/replay, torn-tail repair, coherent fork snapshots.
- `dist/harness/session/{fork.js,fork-policy.js}`: history selection and explicit exclusions when forking.
- `dist/harness/runtime/{harness.js,restore.js,lane.js}`: multi-lane creation, restore without execution, inspect/watch, cancellation and acceptance.
- `dist/harness/runtime/drive/tools.js`: durable tool intent and replay-safe versus unknown-outcome recovery.
- Rechecked mikan `SessionStore`, `MikanAgentSession`, runner binding and session lifecycle against those contracts.

The core README primarily documents the low-level `Agent` interface. It is not sufficient as documentation for the native v4 `AgentHarness`. The coding-agent session-format document describes its own v3 format and must not be treated as mikan's v4 storage specification.

### Durable hierarchy

- **Session:** transcript tree, usage rows, scalar values/lists and serialized mutations; JSONL is one backend.
- **Branch:** a named transcript tip; a data-only branch need not be an executable lane.
- **AgentLane:** a branch with model/thinking/tool-name configuration, its own inbox and current/last operation references.
- **Operation:** one accepted run, compaction or navigation, with a durable execution state and cancellation marker. One user-facing task can span several operations.
- **OperationResult:** immutable completed/declined/aborted/failed record, including source/final tip and timestamps. It describes execution, not verified Slack delivery or domain-level task success.

V4 stores more than messages: `pi.lane.state`, operation metadata/state, pending input payloads, pending tool outputs/assistant frames and final results. Mikan-specific metadata can use non-reserved namespaces; a separate JSON task-state database is not inherently required.

### Five executable v4 experiments

These use native `JsonlSessionRepo`, Node filesystem and `AgentHarness`, with a scripted provider. They do not modify mikan production code or simulate a real OS kill.

| ID  | Scenario                                                                                            | Result                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Main lane and task lane created at an explicit main tip in the SAME v4 file                         | Task inherits source context; main answers while task tool waits; subsequent main/task histories diverge and do not mix.                                                                                   |
| V2  | Accept task and queue steering; close/reopen; attach harness                                        | Open operation and queued entry ID survive. Attach performs zero provider calls. New prompt is rejected while busy; explicit resume executes original request plus steering and persists completed result. |
| V3  | Persist cancellation before drive; close/reopen; resume                                             | Restored operation is aborting. Resume settles aborted without a provider call. Steering/follow-up are gone; `nextRun` survives and is included by a later explicit prompt.                                |
| V4  | Fork a branch versus whole tree from a source with history, open operation and queued input         | Forks start idle, do not inherit live operation/inbox/results. Branch fork excludes application scalar values; tree fork copies them. History is copied, including entries selected by the fork tip.       |
| V5  | Persist application cancellation disposition; append deliberately torn final JSONL fragment; reopen | Committed application value survives; incomplete tail is removed; header is v4/storageVersion 1. This verifies torn-tail handling, not power-loss/fsync durability.                                        |

All five passed. Combined related run: six test files / 85 tests passed. Artifacts: `/tmp/mikan-task-investigation/session-v4-investigation.test.ts`, `/tmp/mikan-v4-results.json`, `/tmp/mikan-v4-related-tests.log`.

### Multi-lane is possible, but not currently wired into mikan

Mikan currently maps platform session key to a file and a cached runner. `SessionStore.mainBranch`, `createHarness`, and context reconstruction target `main`; `MikanAgentSession.initialize` selects `main` and its event forwarding drops other lane events. Per-run mutable executor/upload/reaction/platform-tool bindings assume one serialized runner. Session View tokens and runtime controls address session key/file, not lane.

Using several lanes under one mikan runner without redesigning those bindings could mix actor authorization, output destinations and tool closures. A shared harness also has a shared configuration store and fault/close scope, despite independent lane execution. Native V1 proves capability, not safe drop-in compatibility.

Two viable placement choices:

| Choice                                                    | Reuse / benefit                                                                          | Cost                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate v4 file per task/thread, `main` lane within each | Existing runtime keys, writer leases, responder bindings and Session View remain aligned | Need explicit source-to-task association and context handoff; native fork integration must preserve fixed file paths and mikan metadata.    |
| One v4 file with main plus task lanes                     | Native fork-at-tip context, independent execution and shared session inventory           | Requires lane-aware runtime identity, event dispatch, authorized tool context, lifecycle, UI and inspection. Not merely a storage refactor. |

For incremental implementation, separate v4 task sessions fit current mikan best. Multi-lane remains a real option for a broader conversation model redesign, not a missing native capability.

### Recovery and observation boundaries

`AgentHarness.create` returns an `open` inventory and performs no execution. Mikan's `SessionStore.createHarness` currently returns only the harness, discarding that inventory, and ordinary runner work calls prompt rather than startup recovery. V4 recoverability does not imply mikan automatically resumes interrupted tasks.

Tool recovery records planned/effect_pending/outcome_ready/completed phases. Installed recovery code replays an interrupted effect only when both its stored replay policy and current tool declaration are safe; otherwise it emits an interrupted/unknown-outcome result, using durable progress if available. This is not exactly-once external execution. A handoff transaction cannot atomically include Slack posting and all platform delivery effects merely because the session is transactional.

Native `watch` provides transcript, operation, running tools, queues and last result. It is a useful source for a compact Slack footer without creating parallel status truth. It may contain conversation/tool content: select content-free status/IDs for telemetry, never export raw snapshots wholesale.

Application values could hold source-message association and cancelled-input disposition inside v4. Access must go through the existing writer owner and supported mutation interface; do not reopen an active file or edit reserved `pi.*` state. Session mutations serialize writes, not whole tool executions; never await nested public session writes while holding the mutation callback.

## Follow-up: real process death and mikan runtime integration

Executed 2026-09-15 against baseline `36ac8af`. No production code changes.

### Actual SIGKILL recovery experiment

`/tmp/mikan-task-investigation/v4-crash.mjs` launches a disposable child process using the built mikan `SessionStore` and native v4 harness. The child invokes a local probe tool, appends one invocation marker under its temporary directory, publishes a durable progress checkpoint and queues a correction. The parent waits for checkpoint persistence, kills only that child with SIGKILL, opens the session in another process context and explicitly resumes. The probe models an interrupted external effect; it is NOT an actual deployment or remote service.

| Case                                                 | Actual probe invocations          | Recovery outcome                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool replay policy `never`                           | Original only                     | Does not rerun the effect. Original checkpoint and explicit external-outcome-unknown marker enter recovery context, along with queued correction. Scripted model then completes the operation. |
| Tool replay policy `safe` in both old/new definition | Original plus recovery invocation | Effect is replayed; scripted model receives the recovered result and queued correction.                                                                                                        |
| Safe tool, but cancellation committed before SIGKILL | Original only                     | Reopens as aborting; resume settles aborted with zero model calls and no replay. Checkpoint/unknown-outcome record retained; cancelled steering is not adopted.                                |

All three assertions passed. Original operation ID survives. Reattaching the harness invokes no provider calls. “Completed” in the first case is a Pi operation result from the scripted model, not proof that the original external task succeeded. This proves process-death recovery on local files, not power-loss durability or exactly-once remote effects.

Evidence: `/tmp/mikan-v4-crash-pGIycs/results.json`, `/tmp/mikan-v4-crash-results.log`.

### Integration through existing mikan runtime

A temporary test file reuses the prior ten Slack-adapter/runtime scenarios and adds three cases. Real `ConversationRuntime`, `SessionLifecycle`, runner, presenter and `SessionStore` execute; Slack methods and provider are mocked. A test-only spy captures the created native lane, since no production steering port exists yet.

- **I1:** Queue native steering into the event task; send a normal channel question through Slack mention intake. Channel answer completes before task tool settles. Task's next provider context contains the steering and existing presenter renders its final answer at the task target.
- **I2:** Queue native steering, call existing runtime `handleStop`, wait for settlement, then send an explicit mentioned followup in the task thread. No extra model call happens before continuation. Original task history and new constraint reach the continuation; cancelled native steering does not. This input was injected directly into Pi, not logged as a Slack steering message, so it does not fix or disprove C9's history-reimport problem.
- **I3:** Hold the Slack `Stopping…` post response while allowing task cancellation to settle. After releasing the post, runtime is idle but holds `stopMessageTs = STOP_ACK`, and no final update was sent to that ID. This reproduces a concrete stop-notice race consistent with the earlier live stale notice; it does not prove that race was the exclusive cause of that live occurrence.

I3 source ordering: `handleStop` calls `runner.abort()` BEFORE awaiting `bot.postMessage`, and only sets `stopMessageTs` after posting resolves. `postAbortNotice` can execute during that wait, before the ID is available. Cancellation is therefore independent of stop-notice delivery. No repair was bundled into the experiment.

Temporary integration suite: 13 tests passed (10 prior scenarios plus 3 additions). Combined relevant run: six test files / 93 tests passed. Tests demonstrating failures assert current behavior; they are not acceptance tests showing the proposed feature is production-ready.

Evidence: `/tmp/mikan-task-investigation/task-runtime-control-experiment.test.ts`, `/tmp/mikan-runtime-control-results.log`, `/tmp/mikan-v4-integration-checks.log`.

### Decision supported by this round

Separate v4 task sessions plus the existing runtime are a viable incremental base for nonblocking conversation and native steering. Runtime admission/recovery, control input disposition, cross-user authorization and Slack acknowledgement settlement still need implementation. Do not write a second execution-state machine to replace Pi. Do not automatically retry unknown external effects, or mark stopped until actual run settlement.

All spawned crash-test children exited. Temporary integration code was archived outside the worktree. No Slack connection, model service, production daemon or sandbox was started in this round. Only the research document remains as a worktree change.

## DM implementation acceptance after competing consumer stopped

2026-09-15: requester confirmed another mikan consumer was running and stopped it. Repeated tests with the feature daemon; every submitted test message below is present in this daemon's own office intake log.

- Task anchor `1789441537.622429` retained its acknowledgement. Task bash ran 11:05:40–11:07:10 Taiwan time. Main-DM question `1789441554.255179` received reply `1789441556.645509` in 2.39 seconds while that tool remained active.
- Steering `1789441584.396759` was received in the correct task thread and acknowledged immediately. The existing task produced `ACCEPT_STEERED` rather than the original requested string, with no extra task tool execution.
- First stop attempt was invalid as an early-cancellation test: browser text insertion failed and the actual message arrived only during final presentation after the tool finished. This exposed a separate stop acknowledgement gap when Pi had already completed but runtime presentation had not. Fixed `handleStop` to await captured run settlement and finalize any still-owned acknowledgement; added a permanent regression test.
- Retried with a 120-second sleep. Pending steering `1789441824.170879` preceded actual stop `1789441825.219529`; bash aborted after 20.2 seconds. No answer to `DISCARDED_02` appeared. Restarted the feature daemon with the repaired build, then continued in the same task thread with `1789441869.129929`; response `1789441871.911569` was `RESUMED_NEW_LIMIT`, with no tools.
- Final repaired-build stop: request `1789441890.113199`, stop `1789441904.353329`; tool aborted after 10.3 seconds and acknowledgement `1789441904.878009` read `Stopped.`. Earlier stale notices are test artifacts, not repaired historical messages.

Acceptance task: https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789441537622429

Provider/model: macmini/gpt-5.6-terra, thinking off. Real Slack browser input/API readback, Socket Mode intake and Docker native bash; not production deployment and not an arbitrary-task autonomy benchmark. English steering acknowledgements and top-level stop notices remain current presentation limitations. Main-DM natural-language task targeting, automatic crash recovery, and cross-user/attachment control extensions are not implemented.

Verification after repair: 128 test files / 1,767 tests passed; build, lint, format and Knip passed. The feature daemon is deliberately left running for requester UX acceptance using isolated state `/tmp/mikan-task-feature-64oBJD`. PID information is in `/tmp/mikan-task-feature-current.json`; private live evidence is `acceptance.json` and `daemon.log` under that state directory. No npm release or production deployment.

## Recheck after requester removed Agent App surface

2026-09-15, Taiwan 11:28–11:30: kept the same feature daemon (PID 62312), made no code or manifest changes during this recheck. Browser now labels mikan as an application rather than an agent. All five test inputs were confirmed in the feature daemon's own intake log.

- Task anchor `1789442892.520939` remained unchanged; native bash ran 11:28:16–11:29:15.
- Independent main-DM question `1789442909.791129` got answer `42` at `1789442911.943339` (2.15 seconds), before task completion.
- Steering `1789442941.582569` received confirmation at `1789442944.169199`. Task final text was `PLAIN_STEERED`, replacing the original requested answer inside the task reply, not the anchor.
- A second 60-second wait in that thread started at 11:30:03; `stop` at `1789443026.733469` aborted it after 23.5 seconds. Slack API confirmed acknowledgement `1789443027.397059` reads `Stopped.` in main DM.
- Opening the application still produced `setSuggestedPrompts failed: not_agent_app` in logs (11:26:24 and 11:27:47). Current code treats `app_home_opened` Messages as an agent surface even for an ordinary app; that ancillary call needs capability-aware handling. It did not prevent tested message/task/control delivery. No claim that all assistant-specific API scopes or UI navigation behavior are validated.

Private evidence: `/tmp/mikan-task-feature-64oBJD/plain-dm-recheck.json`. Task link: https://geminixiang.slack.com/archives/D0B4BL40DAN/p1789442892520939 . Browser navigation still occasionally showed an App Home or loading surface; do not attribute every prior navigation issue solely to agent_view without a controlled UI comparison. Daemon remains running for user acceptance.

## Thread stop routing and completion delivery repair

2026-09-15: failing regressions first demonstrated top-level stop output and
absence of fresh requester notification. Repair passes source `thread_ts`
separately from execution session key, removes competing stop-message-id ownership
from abort finalization, and lets the explicit stop caller post/update its own
acknowledgement through settlement. Shared-channel bare thread stop now reaches
intake. Runtime-originated force stop can use the target session thread.

DM task normal textual completion posts a fresh in-thread raw-user-ID mention;
error/aborted/silent turns do not post that notice. It means a result is available,
not necessarily that the requested domain action succeeded. Push/banner delivery
is controlled by Slack/user settings and was not verified.

Live local-daemon verification after idle reload (PID 88707):

- Task response `1789443550.662249`, fresh notification `1789443558.853329`
  contains native `<@U0B4878MUER>` in task root `1789442892.520939`.
- Stop input `1789443588.833919`; acknowledgement `1789443589.410479` reads
  `Stopped.` in that same thread. No new top-level messages in the test interval.
- The cancelled run produced no second completion mention.

Evidence: `/tmp/mikan-task-feature-64oBJD/stop-notification-acceptance.json`.
Unit/integration suite: 128 files / 1,771 tests passed. Shared-channel routing
is covered locally; this repair's live retest was in DM. Test daemon remains on
for user acceptance; no release/deployment/commit was performed.

## Natural-language acceptance after explicit /pi-new

2026-09-15 11:51 Taiwan: submitted actual `/pi-new` in the main DM;
local log confirms `Session reset: D0B4BL40DAN` at 11:51:12 and subsequent
main session suffix `2e68c4ab`. Reset preserves office memory/files as designed;
it is a clean transient conversation, not a new installation.

User prompt: 「幫我看看 geminixiang/mikan 最近更新了什麼，整理幾個重點給我。」
No tool names, sleep duration, background/thread instruction or synthetic token.
At 11:51:33 the model handed off to task root `1789444293.055259` and posted
「我會查看 geminixiang/mikan 的近期提交與變更，整理重點給你。」
Task ran seven read/query bash calls against public repository sources.
At 11:52:03 a separate natural DM question 「順便問一下，DM 是什麼意思？」
started and answered at 11:52:07, before task response at 11:52:21.
The task ended with a fresh native requester mention in the same thread.

This verifies autonomous handoff and nonblocking conversational delivery in one
fresh-session natural-language case. It does not verify every factual statement
in the generated repository summary or general routing accuracy. UX remains
verbose: seven completed tool labels precede a long summary, followed by a usage
message. No product/prompt code was changed for this acceptance test.

## Impatient requester scenario, fresh /pi-new (2026-09-15)

Adjusted only handoff acknowledgement guidance in the system prompt/tool schema:
brief conversational wording, not a formal task restatement, no invented ETA.
Reloaded idle local daemon; PID 93877. Focused suite: 11 tests passed.
Actual `/pi-new` reset preceded the natural request:
「幫我看看 geminixiang/mikan 最近十個版本改了什麼，哪些會影響使用者，整理給我。」
Task anchor: `1789444652.849109`.

Observed acknowledgement: 「好，我來查最近十個版本的變更，並標出使用者會感受到的影響。」
It is somewhat more conversational but still repeats the plan and does not explicitly
promise notification; do not claim exact compliance with the desired example.

Main-DM repeated questions were actually received (including a repeated retry of
「現在做到哪了？我有點急。」). Replies arrived in roughly 4–6 seconds, did not create
another task, but asserted specific progress without querying runtime state:
「正在核對 GitHub 的 release/tag 順序」 and 「已在彙整最後的使用者影響」.
These are ungrounded status claims even if temporally plausible. The main agent
has no dedicated task status port; prompt polish does not solve this gap.

First thread question 「還要多久？先給我重點就好。」 arrived at original finalization
(11:58:22), started a subsequent run at 11:58:23, and generated a shortened answer
with another completion mention. It did not test mid-tool steering.

A second real task asked to verify actual commits for compatibility risks. While
running, 「有進展嗎？」 and 「還要多久啊？」 both received generic steering acknowledgements.
They remained in the same task session; tool failure/retry and continued investigation
were visible in local logs. Final output at 11:59:59 addressed progress but remained
lengthy. No claim of immediate grounded status response or accurate ETA is supported.

Verdict: background execution and native steering survive repeated questions, but
impatient-user UX does NOT pass: main status is speculative; thread queries are
all treated as steering; short followups receive redundant completion mentions.
Next work should expose actual scoped-run/task state to main conversation, distinguish
status observation from changing instructions, and limit completion pings to meaningful
task delivery rather than every ordinary followup. Do not add phrase-only status claims
as a substitute for authoritative state.

Private intake/response evidence: `/tmp/mikan-task-feature-64oBJD/impatient-acceptance.json`.
Daemon remains running. This round changed acknowledgement guidance only, not status
query or completion semantics. No release, commit or production deployment.

## Grounded status implementation and impatient-user retest

Implemented responder-bound `task_status` for Slack DMs. It lists up to ten
recent task anchors in the current office, uses runtime running/stopping/current-tool
observations, and reads native v4 terminal results through a private snapshot
without acquiring the live writer. Unknown/open-without-runtime state stays unknown;
no ETA or completion percentage is invented. Task acknowledgement is identification,
not progress evidence.

A narrow full-message task-thread status shortcut answers common pure status
questions without LLM/steering. Mixed instructions are intentionally not classified
by this shortcut. Ordinary text-only followups and status-only tool runs do not
send completion mentions. Actual work tools still qualify for a completion notice.
This is an initial policy, not a general intent classifier.

Live retest after `/pi-new`, 2026-09-15 12:32 Taiwan, task root
`1789446756.083169`: natural compatibility-risk request autonomously handed off.
Main-DM impatient queries at 12:33:04 and 12:35:22 both invoked `task_status` before
answering; no duplicate task was admitted. Task stayed active until 12:35:34.
Thread 「還要多久啊？」 reported current tool `subagent` with no ETA. Thread
「有進展嗎？」 during a gap reported running without inventing a phase. These
queries did not create model runs. After completion, 「好了嗎？」 directly reported
the terminal state and did not generate a second completion mention.

Remaining observation: the first model paraphrase still turned the task description
into a phase-like statement despite calling the status tool. Strengthened prompt
instruction to use only currentTool as activity evidence; absent currentTool means
no precise phase is known. Hid task_status progress labels without dropping tool
telemetry. After idle reload, a main-DM completion query at 12:39:32 invoked task_status
and correctly reported completed around 12:35, proving persisted status survives
restart. It also unnecessarily probed session files; follow-up prompt guidance now
forbids those extra probes for status-only requests. This final wording refinement
requires continued UX observation, not a claim of universal compliance.

One query submitted around reconnect was delayed until after its retry; both
subsequently appeared in local intake. Do not interpret that retry as steady-state
model latency. No user configuration or production service was changed.

Verification: 128 files / 1,775 tests pass; build/lint/format/Knip pass before the
last prompt-only refinement. Feature daemon and full test outcome tracked in
`/tmp/mikan-task-feature-current.json` and `/tmp/status-final-tests.log`.

## Draft PR stability investigation: delivery is not settlement

Draft #149 opened from `81b74c9`, branch `feat/dm-task-handoff`. Pre-commit full
gate passed (1,775 tests). Subsequent local failure injection uncovered a release
blocker in the implementation, not a failed live Slack experiment.

### Confirmed: rejected final updates still yield completion notification

One executable regression-style investigation uses the real Slack responder,
progressive renderer, runner, runtime and native Pi persistence, with a scripted
model and a fake Slack update transport. It rejects EVERY update containing the
final answer while allowing notification posts. Observed all three together:

1. Final-result updates are rejected.
2. A fresh requester completion mention is nevertheless posted.
3. `task_status` reports the native operation as `completed`.

The test passed as an assertion of CURRENT undesirable behavior. It is not evidence
of successful delivery. Repro copy: `/tmp/mikan-task-investigation/task-stability-investigation.test.ts`
(copy into `src/test/` to run); result `/tmp/task-stability-results.log`.

Source chain: `ProgressiveRenderer.run()` catches platform errors and resolves
its promise. `publishFinalResponse()` interprets fulfilled `replaceResponse()` as
success and returns true; `finalizeRunResponse()` then posts the completion notice.
Separately, Pi's terminal record correctly says its operation completed, but that
record does not attest Slack delivery. The boolean recently added to the presenter
cannot solve a failure swallowed below it.

Before ready-for-review: make final-delivery outcome explicit through the existing
responder seam, keep best-effort incremental rendering distinct from required final
delivery, and prevent completion notices from claiming a result location when that
result is missing. Do not rewrite Pi's terminal state as platform failure or create
an unrelated second execution state machine. Cover native-stream, buffered,
subagent-dashboard and Block Kit-owned final paths separately.

### Additional design risks, not yet reproduced in this round

- `deliverTaskUpdate` falls through to normal queueing when steering returns false;
  runtime running begins before `MikanAgentSession.runActive`, so preparation gaps
  need admission/stop tests. Don't claim all pre-start controls are handled.
- Custom input disposition and native steering are separate mutations. A process
  failure between them could suppress an input in history without delivering it;
  acceptance/consumption/cancellation semantics need a durable review.
- Task membership is reconstructed from platform logs while execution is read from
  v4. Old anchors survive `/pi-new`; newest-ten selection can omit older active
  tasks. Clarify scope/retention rather than adding ad hoc fallbacks.
- Task-status snapshots read whole files and queries may inspect ten files. Measure
  realistic large sessions before deciding whether live-writer snapshots or a
  narrower stored result projection is needed.
- The full-message status regexp is only a UX shortcut. Arbitrary phrasing still
  relies on model tool usage/paraphrase, and work-tool-count completion pings do
  not represent a complete domain-level delivery policy.

No live daemon changes, external Slack failure injection or production operations
were performed during this stability investigation. Draft remains intentionally
not release-ready.

## Five bounded iteration cycles after draft creation

2026-09-15, baseline `393a41c`. Five distinct hypotheses/changes, followed by
combined real Slack acceptance. Not five independent deployments or full platform
matrices; each item below states its actual verification level.

| Cycle                       | Red evidence / question                                                                                      | Change                                                                                                                                                                                                             | Verification                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1: Required final delivery  | Three failing tests: buffered/native replacement errors resolved; failed final answer still pinged requester | Renderer replacements/finalization now propagate errors while best-effort progress remains recoverable. Queue is not poisoned by failed replacements.                                                              | Three regressions green, then full 1,778 tests pass. No injected real Slack outage.                                    |
| 2: Preparation cancellation | Gated runner `reloadFromSession`; stop still allowed another provider call (4 instead of 3)                  | Runner remembers stop across preparation, returns aborted before prompt, clears active identity on preparation failure. Preparation/settlement controls are explicitly rejected rather than queued as another run. | Regression green. Live stop retested during ordinary task execution, not at an externally forced preparation boundary. |
| 3: Active task visibility   | Older running task disappeared behind eleven newer anchors                                                   | Include all active task roots even beyond recent-ten history limit; filter active identity by office/platform                                                                                                      | Regression green. Unknown state remains unknown; no new execution-status cache.                                        |
| 4: Completion policy        | Initial reasoning-only delegated task produced no mention                                                    | Initial task handoff qualifies for completion notice even without tools; ordinary non-work followups remain quiet                                                                                                  | Regression green; cancelled/error delivery checks retained.                                                            |
| 5: Simplification/isolation | Duplicate task-root parsers and repeated scan in acknowledgement path                                        | Share readTaskRoots; compute per-intake task membership once for acknowledgement decision; test malformed records and foreign-platform status                                                                      | Integration test green; no new cache/compatibility layer.                                                              |

Combined live acceptance, isolated local daemon PID 59297:

- Actual `/pi-new` followed by natural prompt 「幫我整理 geminixiang/mikan 最近五個版本的更新，挑三個最影響使用者的重點就好。」
- Anchor `1789448222.368599`: 「好，我來整理一下。」 Result and exactly one requester mention delivered in its task thread.
- Main query `1789448238.545269` used task_status, not guessed progress. Its response was posted about 1.9 seconds AFTER task completion notice while reporting the earlier running observation: snapshot-to-LLM-response staleness is a newly observed remaining UX issue, not a duplicate run.
- Completed-thread 「好了嗎？」 responded directly with no new completion mention.
- Natural followup requested actual ten-version code-risk investigation. 「有進展嗎？」 reported the live tool label; subsequent stop produced `Stopped.` at `1789448301.728419` in the same thread, no top-level stop and no cancelled-task completion mention.

Private evidence: `/tmp/mikan-task-feature-64oBJD/five-cycles-acceptance.json` and daemon log. Timing/transport experiments are local deterministic tests, not platform outage reproduction. Feature daemon remains running for requester testing.

Remaining draft blockers: execution completed is still distinct from durable delivery outcome; startup queue admission and crash before control submission; status snapshot staleness while model composes reply; completion mention transport failure; same-session repeated concurrent stop ownership; status-query cost for large archives. Required final delivery now propagates failure, but the existing status text can still imply a result is visible after transport failure. Do not move this PR out of draft on the strength of the five cycles alone.

## Five-cycle convergence group and stopping decision

Baseline `0f700b2`; no feature-scope expansion. Each cycle ran focused tests;
full gate before live acceptance: 128 files / 1,784 tests.

1. Consolidated task tools/binding: two setter pipelines became one `bindTasks`;
   removed `harness/tools/task-status.ts` without changing model-visible tool names.
2. Status query uses one office-scoped map and sequential historical snapshots;
   avoids repeated running-list scans and up to ten simultaneous parsed snapshots.
   Completed wording no longer asserts result delivery. This is structural reasoning,
   not a measured performance benchmark.
3. Red/green main-DM pure-status regression; main and thread share observation
   behavior. Multiple active tasks produce disambiguation rather than guessing.
4. Both SessionStore inspections use one snapshot lifetime helper; cleanup now
   removes temporary files even if repository cleanup throws. Existing inspection,
   task and portal tests remain green; no new storage backend or cache.
5. Status-only model turns omit user-facing usage chatter while keeping metrics;
   mixed instructions continue to reach the model, not swallowed by the shortcut.

Live `/pi-new` acceptance on geminixiang (local daemon PID 75884): natural ten-version
upgrade-risk request, anchor `1789449162.827189`. Main 「好了嗎？」 at
`1789449183.841989` got an actual current-tool response at `1789449184.417909`
(~0.58s), without a model run. Thread 「還要多久？」 used the same read-only
observation during task output generation. Final requester mention at
`1789449242.262879`. Every test input is in local intake; task reports remain
model-generated content, not independently fact-checked here.

Code comparison before documentation/test additions: product edits total 161 added,
165 removed, net -4 lines and one fewer file. This is modest overall reduction;
real gains are fewer binding/snapshot/query decision points and direct status UX.
Do NOT claim that the whole task architecture has converged or that five full
platform test matrices were executed.

Stop after this group: further incremental moves have marginal benefit. A larger
module redesign would need an explicit replacement interface/ownership decision,
not more pass-through helpers. Remaining blockers include delivery-state semantics,
admission durability, control acceptance atomicity, and general natural-language
status/control routing. Draft stays draft. Local evidence:
`/tmp/mikan-task-feature-64oBJD/convergence-acceptance.json`.

## Sentry / OTLP actual receipt verification

2026-09-15 06:45:58 UTC. After requester refreshed gcloud auth, read production
environment key presence only: SENTRY_DSN and OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
HEADERS, PROTOCOL were set. No secret values were printed. Production package
remains 1.0.0-beta.59; daemon was not restarted.

A separate short-lived Node process on clanker-002 used the installed mikan
observability functions and production destination settings to send a synthetic
error/span, labelled telemetry-verification. It contained no conversation text,
tool arguments, commands from agent work, or credentials. This is a transport
probe, not an actual task failure or verification that unreleased PR code runs in
production. Probe source was removed from VM after execution.

Both receiver-side queries succeeded in Sentry project pi-agent:

- Error event: `5c2ad8e27ba747e9892bffb549093293`, issue `7732850192`,
  title `Error: Synthetic task telemetry verification`.
- Trace: `35b0002ea4aac53ee491f0ebd46f6128`, span `2cd7c15e0e60133d`.
  Trace indexing was not immediate; retry after 15 seconds returned the span.

No issue was resolved/deleted. SDK flush=true was observed but not used as sole
receipt evidence. The JS probe used a synthetic domain tag `tasks`; PR code uses
the existing typed `mikan` domain plus task-specific surface/operation tags.

Added reports for task-admission tool errors, asynchronous task-start failures,
and task-status snapshot inspection failures. Existing runtime/final-delivery
reporting remains. Local admission regression confirms reportUserFacingError is
called with no task payload. Full suite: 128 files / 1,785 tests passed, build,
format and Knip pass. Fixed a test ordering assumption: runtime running state can
precede the second provider call, so concurrent-task test now waits for that call.
This does not guarantee emission during SIGKILL/network outage or delivery of every
possible expected/rejected control. Local UX daemon still has Sentry disabled.
