---
status: accepted
---

# Durable agent audit and raw diagnostic traces are different products

mikan stores a default-on, deployment-owned, metadata-only agent-loop audit in SQLite for indexed Admin queries, retention, and operational accountability. The audit records typed run, turn, logical model-request, tool, retry, compaction, budget, and subagent lifecycle facts; it does not persist prompts, completions, thinking, tool arguments/results, provider payloads, headers, file bodies, or terminal output. Exact high-sensitivity evidence, if added later, is a separate opt-in short-lived diagnostic trace rather than an expansion of the durable audit schema.

SQLite work runs behind a bounded non-throwing producer queue in one worker thread. Audit loss or writer failure marks the service degraded and remains visible through health counters, but never changes an agent result or run cleanup. Runtime admission owns top-level `runId`; subagents own child IDs correlated by `parentRunId` and `parentToolCallId`; model entries describe logical mikan requests rather than claiming visibility into provider-internal retries.
