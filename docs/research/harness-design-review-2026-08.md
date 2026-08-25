# src/harness/ design review — 2026-08-26

Scope: full design pass over `src/harness/` after the pi 0.84.3 / v4-session
alignment landed on main. Method: three parallel reviews — extensions
(`loader/registry/types`), subagent system (`subagent-runner/profiles/models/
auth/usage/settings/http` + `tools/subagent*`), and run loop / session store
(`runner.ts`, `session-store.ts`) — merged and spot-verified against source.

Framework: AGENTS.md File-Split Scale (Slot / Authority / Weight) plus
resource-authority analysis (one rule, one home).

## Verdict summary

Files with no actionable design fault: `auth.ts`, `settings.ts`, `http.ts`,
`subagent-profiles.ts`, `event-format.ts`, `usage.ts` (algorithm; naming is
finding S4), `tools/subagent.ts` (weight justified by DAG/wave knowledge).

Findings are ordered by severity within each area. IDs are stable for
follow-up commits.

## A. Extensions (`src/harness/extensions/`)

### A1. Failed activation leaves partial registrations — correctness

`loader.ts:655-712`, `registry.ts:82-154`. All extensions share one registry;
`activate(api)` can register hooks/tools/disposers and then throw. The loader
logs the error but never rolls back, so a failed extension is absent from the
success list yet partially live (and may have leaked resources if it never
reached its disposer registration).
Fix: stage registrations per-extension and merge atomically on success; on
failure run that extension's registered disposers and drop its registrations.

### A2. `before_agent_start` block contract is violated by execution order — correctness

`extensions/types.ts:70-78` promises "model is never called and nothing
persists" on block; `runner.ts` checks auth (~295) and may run threshold
compaction (~312) _before_ dispatching the hook (~319). A blocked turn can
still make model calls, record usage, and persist a compaction entry — and a
missing credential prevents the extension from blocking at all.
Fix: dispatch `before_agent_start` before auth validation and pre-turn
compaction, or rename/re-document the hook if maintenance compaction is
intentionally exempt.

### A3. Tool names have no conflict authority — correctness

`registry.ts:86-88` (`registerTool` is a bare push), consumed at
`runner.ts:125` (`[...options.tools, ...contributed]`). Commands, actions and
callbacks each have an explicit duplicate policy; tools have none. An
extension can shadow a built-in tool (or collide with another extension) and
the winner is decided by downstream array order.
Fix: validate final tool-name uniqueness at assembly with owner-attributed
errors; record tool owners in the registry.

### A4. `loader.ts` is two authorities: activation and the host API — structure

`loader.ts:87-354, 400-620, 646-830`. Discovery/import/manifest/activation is
one concern; `buildExtensionApi` (data paths, secrets, schedule stores,
platform messaging, Block Kit, actions, subagents) is the permanent
host-capability seam. They change for different reasons.
Fix: move `buildExtensionApi` + schedule adapters to an `api.ts` authority;
loader keeps discovery/activation transaction only.

### A5. `registry.ts` hosts two wire grammars — structure

`registry.ts:27-55` (slash/bare command grammar), `416-454` (platform
action-id grammar: `EXT_ACTION_PREFIX`, `namespaceActionIds`,
`parseExtActionId`). Both survive the deletion test independently of the
registry: adapters consume them as stable protocol.
Fix: extract each grammar to its own authority (or one named routing
authority); registry keeps registrations + dispatch.

### A6. Hook result-combination policy is implicit — maintainability

`types.ts:63-190`, `registry.ts:254-412`. Generic `emit` is
first-non-undefined-wins; `before_agent_start`/`context`/`message_end`/
`tool_result` each have bespoke chaining dispatchers. Adding a hook requires
touching hook map + storage + choosing/writing a dispatcher, with no
manifest declaring which policy a hook uses.
Fix: single hook manifest mapping each hook to a dispatch policy
(observe / first-result / chain / block-and-chain); registry derives
dispatch from it.

### A7. `session_compact` lacks run provenance — question

`runner.ts:625-632`: `turn_end`/`agent_error`/`budget_exceeded` carry
`origin`; `session_compact` does not, though the runner has it in scope.
Decide: run-lifecycle hook (add `origin?: RunOrigin`) or session-maintenance
hook (document the absence).

### A8. Registry dispatch has no closed guard — question

`registry.ts:230-248`: dispose closes resources but leaves handlers/commands/
actions live; a stale reference can still dispatch into disposed extensions.
Needs a reachability check along platform callback ownership before fixing.

## B. Subagent system and models

### B1. `harness/subagent-runner` imports from `tools/` — dependency direction

`subagent-runner.ts:21` imports `SubagentSlotPool`/`unboundedSlotPool` from
`src/tools/subagent-slots.ts` while `tools/subagent.ts` imports the runner:
a conceptual cycle. The slot pool is process-wide subagent execution
authority, not a tool concern.
Fix: move `subagent-slots.ts` into `src/harness/` (tools keep their per-call
concurrency limit).

### B2. `maxDurationMs` has two live authorities — correctness

`subagent-runner.ts:634-661` (outer `setTimeout` → status `"timeout"`) and
`runner.ts:510-520` (budget check at accounting points → status
`"budget_exceeded"`). The same configured value produces a different terminal
status depending on event-loop timing. The outer timer is the only mechanism
that can abort a stalled provider call, so it stays.
Fix: stop passing `maxDurationMs` into the session budget; duration is the
outer timer's rule, the session budget keeps tokens/cost/llmCalls.

### B3. Profile menu and profile resolution accept two registries — interface

`tools/subagent.ts:488-529` builds the enum/menu/validation from a passed
profile map while the `runSubagent` callback closes over its own copy;
`agent.ts:1462-1477` currently passes the same object, but the interface
permits divergence between what the model sees and what executes.
Fix: bind profiles into the runner and derive the tool from that single
object (`createSubagentTool(subagents)`).

### B4. `MikanAgentSession ⇄ subagent-runner` fold protocol — interface (from run-loop review)

`foldExternalSpend`/`getLastRunStats` form a two-phase usage protocol between
parent runner and subagent runner with no single description of the invariant
(external spend must be folded before `getLastRunStats` is read for the
result). Works today; fragile under change. Candidate for a short protocol
note on the type, not a restructure.

### B5. `getApiKeyForProvider` flattens model-scoped auth — semantics

`models.ts:315-327` picks `getModels(provider)[0]` and swallows resolver
errors to `undefined`, silently asserting "all models of a provider share
auth" and conflating unset with broken.
Fix: prefer `getApiKey(model)`; where only a provider id exists (admin
projection), choose the canonical model explicitly there. At minimum rename
to `tryGetApiKeyForProvider`.

### B6. `MikanModels` exposes both the wrapped `Models` and thin aliases — interface

`models.ts:238-249, 265-273, 310-313`. Two ways to do everything; callers mix
them (`runner.ts:388` uses `models.models.streamSimple`, others use aliases).
Fix (minimal): drop pure aliases, keep `readonly models` plus genuinely
additive methods.

## S. Shared / cross-cutting

### S1. Session-store writer claims interact badly with never-closed stores — resolved

Found via CI: leaked claims + Linux inode reuse denied unrelated new writers.
Fixed in `02e394d` + `bdaea27` (stale-claim detection + birthtime identity).
Residual design note: 25 `SessionStore.create` calls in
`harness-runner.test.ts` never close; the claim lifecycle remains
global-state that tolerates leaks rather than preventing them. Acceptable
now that claims self-heal; revisit if claims grow more state.

### S2. `subagent-runner` in-memory sessions bypass the writer discipline — observation

`subagent-runner.ts:652` uses `SessionStore.inMemory` (no claim, no close).
Consistent today; worth a comment so the asymmetry is intentional.

### S3. Retry loop vs `retryAssistantCall` — resolved (kept)

Evaluated replacing the runner's cross-run retry loop with pi-ai's
`retryAssistantCall`: rejected. Budget-exceeded cannot veto helper-scheduled
retries, `auto_retry_end` timing would shift relative to `agent_end`, and
cancellation text differs — all adapter-visible. Classifier already adopted
(`02fb8b3`).

### S4. Usage aggregation is misnamed as subagent-specific — naming

`types.ts:103-107` (`SubagentUsage` ≈ `Usage`), `usage.ts`. The aggregator
is the harness-wide accounting authority (parent completions, compaction,
external folds), not subagent-specific.
Fix: rename to `AggregatedUsage`/`createEmptyUsage`/`addUsage`/`copyUsage`.

### S5. Aggregated `totalTokens` ignores provider totals — question

`usage.ts:14-18` recomputes `totalTokens` from components instead of
accumulating `usage.totalTokens`; context accounting elsewhere prefers the
provider total when present. Verify whether any provider reports a total
that differs from the component sum (e.g. reasoning tokens) before changing.

## Relation to future pi AgentHarness migration

Replaceable when pi's harness hooks land (keep mikan's extension contract,
adapt underneath): the `context`/`tool_call`/`tool_result` bridges in
`runner.ts:134-164`, and the rewrite/block portion of `before_agent_start`.
Uncertain: `message_end` rewrite (no upstream equivalent yet).
Permanent mikan assets: extension discovery/trust/manifest/secrets, data
paths, commands, Block Kit routing, schedules, platform capabilities,
subagent capability and budgets, run-origin provenance.

## Suggested fix order

1. A2 (hook contract violation — user-visible correctness)
2. B2 (dual duration authority — user-visible status flakiness)
3. A3 (tool-name conflicts — silent shadowing)
4. A1 (activation rollback — failure-path correctness)
5. B1 + S4 (mechanical moves/renames, low risk)
6. A4/A5/A6 (structural splits; do when touching those files anyway)
7. B3/B5/B6 (interface tightening)
