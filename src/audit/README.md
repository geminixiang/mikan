# src/audit

Deployment-owned agent-loop audit authority.

## Contract

- `AgentAuditStore` is created once by the process composition root and shared by runtime, runner, harness, subagents, and Admin.
- Runtime admission creates the top-level `runId`; child subagents receive their own `runId` plus parent-run/tool correlation.
- Producers record a closed, metadata-only event vocabulary with an allowlisted details schema. The producer-owned schema is passed to the worker and applied again when database rows are decoded, so corrupt or legacy JSON cannot reintroduce unknown fields. Prompt text, model content, tool arguments/results, thinking, provider payloads, headers, images, file bodies, and terminal output are not stored.
- `AgentAuditRun.record()` is synchronous, bounded, and non-throwing. It only shapes metadata and enqueues it; SQLite work runs in the module's worker thread.
- The worker owns the one SQLite writer connection, migrations under an exclusive lock, WAL mode, batch transactions, projections, indexed reads, run-coherent retention, and shutdown checkpoint.
- Audit failure never changes an agent result. Queue overflow and worker failure appear through `AgentAuditHealth` instead of propagating into the run.

## Storage

The store lives at `<state-dir>/audit/audit.sqlite`. The directory is forced to `0700`; the database and WAL/SHM companions are forced to `0600`. Events and projections expire after 90 days by default.

Canonical immutable evidence is stored in `audit_events`. `audit_runs`, `audit_tool_calls`, and `audit_model_requests` are online query projections updated in the same transaction. Phase 1 is deliberately run-centered: indexed filters select runs, then a selected run exposes its event timeline; cross-run event search is not part of this release. Retention selects expired runs in expiry order and deletes each run's evidence/projections together, repeating bounded batches until caught up. Admin list queries read projections but are intersected with the currently materialized office registry; run detail applies the same office check, returns a bounded newest event page, and the UI can page backward through the complete typed timeline. Admin health returns counters and a generic failure state rather than raw worker or filesystem errors. No endpoint exposes raw prompt or tool content.
