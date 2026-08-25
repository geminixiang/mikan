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

## Fix plan (merged with harness pass; ordered)

Wave 1 — correctness (user-visible or isolation-relevant):

1. F1 `/login copy` key confusion
2. F2 runtime resource key from raw conversation id (+ migration note)
3. G1 Slack thread slash-command session split
4. D1 stale errorMessage + D2 missing finally
5. A2 before_agent_start contract (hook before compaction/auth)
6. B2 dual duration authority (timeout vs budget_exceeded)
7. G2 GitHub participation scope
8. F12 provisioner remove correctness

Wave 2 — authority consolidation (mechanical, low risk): 9. G6 manifest↔registry completeness test 10. G4/G5 literal-name routing → manifest route metadata 11. E1 stateTransitions → SessionLifecycle.transition 12. A3 tool-name conflicts; A1 activation rollback 13. B1 slot-pool move; S4 usage rename; G8 attach move 14. H1 event-filename authority; G9/X3 type sweep

Wave 3 — structural (when touching the area anyway): 15. D3 agent.ts authority split (stage by authority) 16. E2 rotation single home 17. A4/A5/A6 extensions splits 18. F5/F11 vault env contract 19. E8 Office through seams; H2/H3/H4

Open questions before their wave: F-Q1, F-Q2, S5 (totalTokens), E3
(double-ingest repro), G-QA (telegram @bot suffix).
