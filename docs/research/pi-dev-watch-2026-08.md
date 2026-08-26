# pi dev-branch watch — 2026-08

Observation baseline for the durable-harness rework on `earendil-works/pi` `dev`.
Purpose: know when to re-migrate mikan onto the new harness, and diff future
checks against a fixed anchor.

## Anchor

- Checked: 2026-08-27 (local)
- `dev` HEAD: `8b6910732992521bcf907ce39101f8a633a5ba8d` — "feat(agent): make durable drive total" (2026-08-26, Mario Zechner)
- Latest release on `main`: **0.84.3** (2026-08-24). `main..dev` on the release line: dev carries the entire runtime rework, unreleased.
- Primary sources: `packages/agent/docs/runtime-simplification.md`, `packages/agent/docs/work-packages/00–06`, `packages/agent/CHANGELOG.md` `[Unreleased]`.

## What the rework is

The in-memory run loop + append-log session model is being replaced with a
**durable harness**: every step follows

```
prepare → publish intent → perform effect → publish outcome
```

with intent/outcome committed to the session before/after each effect. The
session becomes the state machine; process crash at any point recovers from
durable state ("process loss destroys all live continuations; recovery starts
from the durable state after attachment"). Retry waits, deferred polling, and
mid-tool crashes are all resumable positions, not lost work.

### Concept split (WP06 — implemented)

```
Session       global durable data + one mutation line
Branch        one path through the entry tree, movable tip
AgentLane     Branch data surface + agent operations/configuration
AgentHarness  manager of AgentLanes; never a lane itself
```

Kills the "harness silently means main lane" inheritance. Multiple lanes per
session are first-class — natural fit for mikan's subagent and schedule
sessions.

### Operation state (WP05)

One discriminator `at` with 13 direct leaves (starting / checkpoint /
assistant.{ready,effect_pending,retry_wait} / tools /
deferred.{suspended,effect_pending} /
summary.{deciding,ready,effect_pending,retry_wait} /
navigation.ready_to_commit). One lane-owned Drive is the sole writer; same-
operation callers join the existing Drive; `requestAbort` is the only durable
cancellation.

## Status at anchor

- WP05 M7 complete: all 13 leaves reconciled, total direct dispatcher installed.
- Runtime ≈ 6,280 lines (`runtime/drive` ≈ 4,115).
- **Public drive still disabled. M8 (public surfaces) not started.**
- Session **format 4 still WIP** — "requires no migration or compatibility
  representation" means it can still change shape before release. Mikan's
  freshly-migrated v4 files may need another (cheap) migration pass.
- `session-backends/sqlite-node` is a real package (databasePath, per-session
  sharding): session storage becomes pluggable. Option for mikan to move
  ~11.6k JSONL files into SQLite later.

## Announced breaking changes (agent CHANGELOG [Unreleased])

- Harness runtime + record-log session model replaced wholesale.
- `AgentHarnessTool.execute()` gains a required replay-stable invocation
  metadata argument.
- Storage backends must return exact post-commit `SessionStats` in
  `CommitResult.stats`.
- Manual-drive configuration, action inspection methods, action outcomes,
  snapshot action field removed.

## Implications for mikan

1. **runner.ts run loop** (largest self-built liability) is exactly what the
   durable drive replaces: single-writer sessions, crash recovery, schedule
   wakeups largely become pi-native. Do not touch until M8 ships in a release.
2. **Migration posture is good**: `src/sessions/migrate-v3.ts` + verification
   oracle + production rehearsal pipeline are proven (11,602 files, two crash
   patterns found and fixed). A v4→v5 pass would reuse the same shape.
3. **Tool bridge**: the replay-stable metadata argument on `execute()` will
   touch every mikan tool and the MCP bridge (`src/mcp/loader.ts`) at
   migration time — mechanical, but wide.
4. **Decision unchanged**: follow pi main releases only. Re-check dev when a
   release with the durable harness appears, or when `main..dev` starts
   shrinking (merge-back begins).

## How to re-check

```bash
git clone --depth 60 --branch dev https://github.com/earendil-works/pi.git /tmp/pi-dev-check
cd /tmp/pi-dev-check
git log --oneline <this-doc-anchor-hash>..dev   # what happened since
sed -n '1,60p' packages/agent/docs/runtime-simplification.md  # status section
grep -n "M8" packages/agent/docs/runtime-simplification.md    # public surfaces started?
```
