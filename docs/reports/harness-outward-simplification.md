# Harness-outward simplification

## Scope and acceptance

Start from installed `pi-agent-core` / `pi-ai` 0.85.0 and work outward through
harness, agent/runtime, and platform boundaries. Delete duplicated responsibility
and unnecessary indirection without adding speculative frameworks or changing
application policy. Dependency upgrades and major behavioral changes require a
separate decision. No automatic commits or pushes.

Completion requires evidence-backed review across these layers, cross-review of
changes, and the complete lint, formatting, knip, build, and unit/integration test
gate. A green focused suite does not establish completion of this review.

## Completed baseline

Commit `362e75d` reuses upstream `RetryPolicy`, `contentText`, and provider-scoped
`Models.getAuth`, and removes the single-use `fileRepo` wrapper. Its normal commit
gate passed, including 1677 tests.

## Verified changes in this checkpoint

- `SessionLifecycle`: remove the `settlements` Set whose contents duplicate the
  keys of `settlementSessions`. Derive `settlementCount()` from the existing Map.
  Lease, shutdown, settlement, and office identity behavior stay unchanged.
  Added a test covering counting pending, successful, and rejected settlements.
- Presenter usage summary: replace copying and reversing the full message list
  with `findLast`, keeping the predicate excluding aborted assistants unchanged.
- Presenter activation: merge reset and queue installation into
  `activateRunPresentation`, returning only `wait` and `dispose`. Runner prepares
  payload data before activation and disposes in `finally`; it no longer writes
  the responder/log-context/queue triple. Disposal cancels pending progress timers
  but deliberately does not cancel or drain already queued operations. Tests
  cover delayed output, disposal, inactive event routing, and reactivation.

Claude Code cross-reviewed the initial three source/test diffs and the subsequent
activation change and found no issues.
The duplicate collections have no independently mutated third path; the only
production count consumers are runtime metrics. The presenter predicate is
unchanged and Node 22 supports `findLast`.

Verification including the activation change: full `npm run lint`,
`npm run fmt:check`, `npm run knip`, `npm run build`, and `npm test` passed:
121 files / 1680 tests. Later source changes require fresh verification.
The user explicitly authorized committing and pushing this completed checkpoint;
this does not establish completion of the broader review.

## Retained responsibilities and evidence

- Skills discovery cannot directly use upstream `loadSkills`: upstream follows
  symlinks, while conversation/package skill loading rejects them. Do not build a
  filesystem adapter just to claim reuse. Inline skill rendering is also local
  behavior absent from the upstream formatter.
- Model availability intentionally isolates provider authentication failures;
  upstream all-provider availability is not an equivalent replacement.
- Required subagent tools are witnessed at `execute`, not
  `tool_execution_start`: installed core emits the latter before validation and
  for tool calls suppressed after truncated model output.
- Upstream `retryAssistantCall` retries one model call, not mikan's persisted
  Agent continuation with its budget and compaction policies.
- No equivalent exported run-local usage accumulator has been identified.
  Upstream session accounting is not a replacement for mikan's run-bound budget
  and detached-subagent accounting.
- Session writer exclusion, exact paths, lazy materialization, and inspection
  snapshots remain mikan responsibilities; changing storage API ownership is not
  justified by a superficial similarity in upstream names.
- Removing the outer custom-message `toDurable` changes snapshot timing from
  call time to queued mutation execution. Do not treat this as a pure deletion.
- The progressive renderer owns platform response serialization, native stream
  fallback, rate-limited redraws, overflow messages, and typing lifecycle.
  Presenter queue ordering and renderer operation ordering are different scopes;
  do not remove either merely because both use promise chains.

## Investigations still open

1. Harness core review with Claude Code is complete. Metadata lookup is not a
   drop-in substitution: object → scalar writes retain the earlier object in the
   local parser but overwrite it upstream, so a final-value object guard cannot
   preserve behavior. Upstream object aliasing also differs. Keep replay for now.
   Custom-message routing simplification changes timestamps and removes a public
   method; unused-in-production public queries are API decisions, not automatic
   deletion candidates.
2. Current lifecycle/presenter changes are cross-reviewed; further edits will
   require their own review.
3. Presenter activation change is implemented and Claude cross-review passed.
   It is an activation seam, not full presentation lifecycle ownership:
   finalization ordering remains in runner alongside capability binding and
   authenticated session links. Disposal now owns timer cancellation locally.
   No preparation-failure bug reproduction is claimed. Two presenter/runner
   suites pass (19 tests), including the added delayed-output preservation test.
   The full gate for this revision also passed (1680 tests).
4. Read Discord/GitHub/Telegram context factories and Slack response lifecycle
   in full. They already use the shared renderer; thread/reply destinations,
   numeric IDs, streaming policies, Slack overflow/status handling, and platform
   formatting remain appropriately local. The five renderer/context suites pass
   (175 tests). Continue caller and test inspection before claiming comprehensive
   boundary review.
5. Follow-up review retains `pendingTools` and `toolProgress`: pending entries
   are deleted on completion for activity/duration tracking, whereas progress
   retains completed entries in start order for final output. A parallel-tool
   reverse-completion regression test now covers these distinct lifetimes and
   final rendered output; presenter/runner suites pass (20 tests).
   Claude's finalization review retains wait → finalize → usage orchestration
   and runner-owned authenticated token creation. Attribution is duplicated
   between run state and finalize options, but moving token creation inside the
   finalizer is not strictly equivalent: its early returns would skip token
   creation currently performed before entry. Added four runner cases covering
   event normal/silent/empty output and ordinary chat; they passed before the
   production change. Removed only the duplicate finalize attribution option:
   both rendering paths now read `runState.triggerAttribution`. Token creation
   timing remains unchanged. Claude confirmed equivalence and implemented
   explicit ordinary-chat attribution and event-error token/output assertions.
   The independent Pi reviewer retained GitHub's separate `postMessage` and
   renderer splitting paths, and implemented a GitHub-specific long-response
   regression test proving destination, content order, length bounds, and
   reuse of existing comment IDs. Both agents changed only their assigned tests;
   the integrator inspected both diffs. Four focused suites pass (58 tests).
   Full lint, format, knip, build, and test gates pass (121 files, 1687 tests).
   GitHub validation uses mocks; live API and enqueueEvent coverage remain out
   of scope for this checkpoint.
6. After pushing checkpoint `9f8db6d`, completed five additional bounded rounds
   with Herdr Claude Code and Pi. The integrator decided scope, delegated edits,
   inspected actual diffs, collected cross-reviews, and verified the aggregate:
   - Round 1: Telegram rich-send failure notification/recovery and Discord
     8-second typing repetition/stop-on-first-send regression coverage. Corrected
     an initially wrong test expectation: failed source remains accumulated.
   - Round 2: Removed four redundant Promise forwarding wrappers in Discord and
     Telegram contexts. Kept destinations, numeric ID conversion, renderer await
     boundaries, and platform-local formatting. Promise identity/microtask count
     is not preserved; direct callers do not rely on it.
   - Round 3: Removed the redundant `PresenterEventContext.pendingTools` field;
     handlers now access the same Map through run state. Nullable context fields
     still serve narrowing and were retained; the two tool Maps remain separate.
   - Round 4: Parameterized Telegram recovery coverage to include failure of the
     plain-text failure notice itself. Both cases preserve source and a usable
     queue; no production error-handling policy changed.
   - Round 5: Presenter reactivation coverage starts with completed ordinary and
     subagent progress, then verifies cleared state and an uncontaminated answer
     on the new responder. This covers activation, not full runner finalization.
     Cross-reviews found no remaining blockers. Integrator verification: five
     focused suites / 135 tests; full lint, format, knip, build, and test gates pass
     (121 files / 1691 tests), plus diff checks. No live platform tests were run.
     These five rounds are complete, not a claim that the broader architecture
     audit or deferred persistence-failure investigation is complete.
7. Finish the requirement-by-requirement scope audit and summarize approved
   changes versus deferred behavioral or upstream-migration decisions. Repeat the
   full gate if subsequent implementation changes are made.
