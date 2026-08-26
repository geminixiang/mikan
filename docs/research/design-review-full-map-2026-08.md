# Full design-review map — 2026-08-26

Second pass, covering everything outside `src/harness/` (first pass:
`harness-design-review-2026-08.md`, findings A*/B*/S*). Five parallel
reviews: `agent.ts` (D), runtime/sessions/office (E), sandbox/vault/resolver
(F), adapters/commands (G, four-member team with rg cross-verification),
tools/cli/config/packages (H, self-review). Framework: AGENTS.md File-Split
Scale + resource-authority analysis.

Full per-finding detail (file:line, evidence, fix direction) lives in
`design-review-2026-08/`: `agent-ts.md`, `runtime-sessions-office.md`,
`sandbox-vault-resolver.md`, `adapters-commands.md`. This map is the merged
summary and the fix order.

## D. `src/agent.ts`

- **D1 (correctness/high)** `runState.errorMessage` survives a successful
  retry — recovered runs can return `{ stopReason: "stop", errorMessage:
"503..." }` (`agent.ts:1917-1926,2375`). Fix: assign from the settling
  message unconditionally.
- **D2 (correctness/high)** `run()` lacks the ownership-releasing `finally`
  that `dreamSessionMemory` has (`agent.ts:2232-2375`).
- **D3 (authority/structural)** Five separable authorities in one file:
  prompt policy, resource catalog, execution binding, run presenter,
  composition root. Split by authority when refactoring, not by line count.
- **D4 (authority)** `PiAgentWrapper` mixes agent lifecycle with extension
  routing (`tryExtensionAction`/`tryExtensionScheduleCallback` are thin
  registry delegations); name promises pi-agent scope it doesn't have.
- **D5 (naming)** `getCurrentStep` picks the first pending tool from a Map —
  an undocumented selection policy.

## E. `src/runtime/`, `src/sessions/`, `src/office/`

- **E1 (authority/high)** `getOrCreateState`'s `stateTransitions` map
  hand-builds the same `officeKey|sessionKey` composite id that
  `SessionLifecycle` owns (`conversation-runtime.ts:821-836` vs
  `session-lifecycle.ts:17-27`). Move single-flight into
  `SessionLifecycle.transition(address, sessionKey, fn)`.
- **E2 (authority/high)** Rotation workflow exists twice: runtime's
  `scheduleSharedSessionRotation` and chat-history-sync's rotation option
  path — two independently-enableable workflows over one clock rule
  (`rotation.ts` itself is fine).
- **E3 (correctness/medium)** First sync of a new runner can double-ingest
  (see report §3, `resolveSessionScope` interplay).
- **E5 (authority/medium)** conversation-id handling in admin UI reinvents a
  `platform:id` string grammar instead of using `officeKey`/structured state.
- **E6 (lifecycle/low)** `migrate-v3.ts` placement fine; needs a declared
  support horizon: keep runtime v3 detection, drop `src/index.ts` export,
  delete wholesale after the deployment window.
- **E8 (typing/low)** Runtime holds `Office` but downgrades to
  `conversationDir: string` across the sessions seam; thread
  `office.sessionsDir`/`logPath` through high-level operations gradually.
- Clean: `session-lifecycle.ts` weight, `store.ts`/`office` path boundary,
  `session-key.ts` grammar (no bypasses found by grep), migration/registry
  weight.

## F. sandbox / vault / execution-resolver

- **F1 (correctness/high)** `/login copy` passes a credential-authorization
  key where a runtime-resource key is required
  (`commands/login.ts:40-76`, `sandbox/identity.ts:30-70`) — vault refresh
  can report success while the container holding old credential mounts
  survives. Resolver/identity must return `{ credentialKey, resourceKey }`.
- **F2 (correctness/high, isolation)** `runtimeResourceKey` still derives
  from raw conversation id, so same-id conversations on different platforms
  can share a runtime slot — bypasses ADR-0005 office identity. Needs a
  migration note for live deployments.
- **F5/F11 (correctness/medium)** Vault env transport differs per backend;
  container path silently strips newlines from secret values
  (`sandbox/container.ts:176-188`) while firecracker throws — one env
  contract, validated in one place.
- **F12 (correctness/medium)** Provisioner `remove()` clears ownership state
  even when container removal failed (`provisioner.ts:221-246,991-1007`).
- **F10 (robustness/medium)** Host/firecracker process execution lacks a
  settled `error` handler; share one process-execution primitive.
- **F-Q1** Does cloudflare bridge abort actually kill the remote command?
  **F-Q2** Who guarantees firecracker `hostPath` appears at `/workspace`?

## G. adapters / commands

- **G1 (correctness/high)** Slack thread slash command: event carries the
  thread session, `CommandContext.message` carries the top-level sessionKey —
  `/pi-session` in a thread can token-ize the wrong session
  (`adapters/slack/bot.ts:1092-1231`, `commands/session-view.ts:37-63`).
  Build session identity once, pass to both.
- **G2 (correctness/medium)** GitHub participation state rides on generic
  log existence instead of an explicit scope.
- **G4/G6 (authority/high)** Command manifest is restated: `registry.ts`
  hand-maintains the dispatchable inventory; a manifest entry without a
  registry factory still registers platform-side and then silently
  no-responds — exactly what the manifest claims to prevent. Also
  literal-name routing remnants: Discord `new` branch duplication
  (`discord/bot.ts:518-557`), Slack bespoke `new`/`sandbox` routes,
  Telegram partial native handlers. Cheapest first fix: completeness test
  manifest↔registry (excluding magicWord), then move name-routing into
  manifest route metadata.
- **G8 (placement/low)** Generic `attach` tool lives under
  `adapters/slack/tools/` but is platform-neutral — move to `src/tools/`.
  Block Kit tools correctly stay Slack-side.
- **G9 (typing/low)** Four exported-type placements violate the nearest-
  `types.ts` rule; mechanical sweep.
- Clean: shared intake/progressive rendering, GitHub one-file-per-tool,
  handler-per-command slots, GitHub conversation mapping.

## H. tools / cli / config / packages (self)

- **H1 (authority/medium)** Event-filename validation exists twice:
  `validateEventFilename` in `tools/event.ts:355` and the admin portal's
  hand-rolled name check (`web/admin/portal.ts:1701-1706`). One validator,
  one home (event-format or the store).
- **H2 (authority/medium)** `config.ts` door-policy section
  (`WorkspacePolicyChoice`, `loadConversationWorkspaceOverride`) shares
  vocabulary with `workspace-projection/` — verify one interpretation
  authority when touching either.
- **H3 (coupling/low)** `config.ts` (also observability, commands) imports
  `cli/arg-grammar.ts` for `effectiveStateDir` — config depending on CLI is
  inverted; the state-dir probe deserves a non-CLI home.
- **H4 (naming/low)** `createMikanTools` returns six bind setters; each new
  context-dependent tool widens the surface — consider one `bind(context)`.
- Clean: `packages/` module, `cli/` slots, `event-format.ts`,
  `file-guards.ts`, `subagent-slots` (placement covered by B1).

## Cross-cutting

- **X1** Three "single authority" inventories restated by consumers:
  command manifest (G4/G6), extension tools (A3), profile registry (B3).
  Same fix pattern: derive, don't restate.
- **X2** Raw-id scope keys where office/actor scope is required: F2, G2,
  E5 — ADR-0005 is the rule; these predate or bypass it.
- **X3** Exported-type placement sweep: G9 + AGENTS.md nearest-types rule.

## Status ledger (updated 2026-08-26, after the fix waves)

### Fixed — commits on main, each with a regression test

| Finding                         | Commit    | Fix                                                                                                |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| F1 `/login copy` key confusion  | `97554ef` | remove by resource key                                                                             |
| F2 raw-id runtime resource key  | `97554ef` | office-key identity + boot reap of legacy containers (BREAKING: one-time image container recreate) |
| G1 Slack thread session split   | `4150518` | one session identity per slash dispatch                                                            |
| G2 GitHub first-contact stop    | `07dd0a4` | magic-word stop no longer materializes participation                                               |
| D1 stale errorMessage           | `e6cad3d` | settling message is the authority                                                                  |
| D2 run() missing finally        | `e6cad3d` | try/finally releases runState ownership                                                            |
| A2 before_agent_start contract  | `f300759` | hook before auth + pre-turn compaction                                                             |
| B2 dual duration authority      | `f300759` | deadline timer owns wall-clock alone                                                               |
| F12 remove() swallowed failure  | `a37fa81` | failed removal keeps state and throws                                                              |
| G4/G5/G6 manifest restated      | `ec63d2e` | registry/routing derived from manifest; bespoke `new` routes deleted (−127 lines)                  |
| A1 activation rollback          | `f8028d6` | failed activate rolls back and runs its disposers                                                  |
| A3 tool-name conflicts          | `f8028d6` | owner-tracked, first-wins with logged owner                                                        |
| E1 identity grammar ×2          | `e887e6a` | single-flight moved into SessionLifecycle                                                          |
| B1 slot-pool placement          | `fbcd77f` | moved to harness (reverse dependency gone)                                                         |
| S4 usage misnamed               | `fbcd77f` | createEmptyUsage/addUsage/copyUsage                                                                |
| H1 event-filename validation ×2 | `b282e22` | one validator in event-format.ts                                                                   |
| G9/X3 exported-type placement   | `b282e22` | four types moved to nearest types.ts                                                               |
| D3 agent.ts five authorities    | `0e13b02` | src/agent/ split along crystallized seams                                                          |
| E2 rotation workflow ×2         | `e2b87fd` | weak scope-resolution rotation path deleted (−45 lines)                                            |
| E3 double sync per first event  | `2af4db9` | scope resolution materializes; runtime owns the one per-event sync                                 |

Also fixed along the way (not originally mapped): retryable-error
classifier → pi-ai (`02fb8b3`); writer-claim inode-reuse CI failure
(`02e394d`, `bdaea27`).

### Remaining — deliberately wait-for-demand

Principle (see AGENTS.md File-Split Scale): architecture first, files
later. A rule gets a home when its area is next touched; a file split
happens only when a seam has crystallized inside the existing file and
extension is actually blocked. No standalone refactor commits.

| Finding                                    | Do it when…                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| A4/A5/A6 extensions loader/registry splits | next real change to the extension host API or routing grammar — that demand chooses the cut line |
| F5/F11 vault env contract per backend      | next time any sandbox backend's credential injection changes; define the one env contract then   |
| F10 shared process-execution primitive     | next host/firecracker exec bug or feature                                                        |
| E8 Office through session seams            | the pi-dev AgentHarness migration reshuffles the session layer anyway — fold in then             |
| D4 PiAgentWrapper mixes extension routing  | next change to the runtime↔runner seam                                                           |
| H2 door-policy vocabulary ×2               | next change to config.ts or workspace-projection                                                 |
| H3 config → cli/arg-grammar inversion      | next change to state-dir resolution                                                              |
| H4 createMikanTools six bind setters       | next context-dependent tool addition                                                             |
| G8 attach tool under slack/tools           | next platform-neutral use of attach                                                              |
| B3 profile registry passed twice           | next subagent-profile feature                                                                    |
| B5/B6 models interface tightening          | next auth/provider change                                                                        |
| S5 totalTokens semantics                   | verify against provider data before touching addUsage                                            |

### Open questions (unresolved, low urgency)

F-Q1 cloudflare abort semantics; F-Q2 firecracker hostPath guarantee;
G-QA telegram @bot suffix handling.

### The big one, parked upstream

runner.ts → pi AgentHarness (with the session-layer reshuffle it
implies, incl. E8) waits for pi's dev-branch harness to ship a working
implementation — 0.84.3's AgentHarness is API scaffold only
(every method throws HarnessNotImplemented).
