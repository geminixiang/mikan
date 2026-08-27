# Pruning pass — 2026-08

Three-track read-only audit (web / adapters / harness+agent+runtime) followed
by staged execution. Goal: same core behavior, less code, stronger interfaces.

## Shipped

- `fdfe3f5` — dead surface: unwired admin endpoints, deprecated reportError
  seam, hand-rolled assistant-text extractors → pi-ai `contentText`, dead
  params/fields, thin wrapper. Net −202.
- `2a23fbc` — interface hardening: admin onclick string-building → `data-*` +
  delegated listener (removes the escAttr JS-context escaping hazard),
  session-view page/SSE/message share one request resolver, `ChatAdapter`
  removed from the public surface, `getAvailable` delegates to pi-ai.
- `779888e` — Cloud Build log subsystem removed entirely (−1,161): the GitHub
  adapter carried its own GCP identity + Cloud Build client for a feature
  production never enabled. Product decision 2026-08-27.

Net ≈ −1,350 lines; gate green at 123 files / 1,740 tests.

## Deliberately kept

- **GitHub webhook + polling**: webhook is a poke, not an event source;
  polling owns correctness (watermark + dedup). Product accepted the design
  2026-08-27. Future option if real GitHub users arrive: go webhook-as-event-
  source like codex/claude bots and delete the polling discipline.
- **Extension system**: frozen (ADR 0006), audit found no confirmed dead code.
- **runner.ts run loop**: waiting for pi durable harness (see
  `../pi-dev-watch-2026-08.md`).

## Investigated and skipped

- `prune-usage-diff.md` — the two usage tallies measure different things
  (parent-only vs with-subagents); unification would change reported numbers.
- `prune-registry-plan.md` — office registry's reverse import of the GitHub
  adapter is entangled with legacy migration semantics; plan filed, not
  executed.

## Remaining candidates (wait for demand)

- Admin loader fetch/loading/error orchestration (~35–60 lines, confirm).
- Login/session status-page renderer merge (~14–22 lines, confirm).
- GitHub concrete-bot method narrowing and test-only export tightening.
