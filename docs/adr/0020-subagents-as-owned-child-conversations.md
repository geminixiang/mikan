---
status: rejected
---

# Subagents run as task-owned child conversations of the office Harness

Rejected: today's subagents work, and the change would not alter what users see. The background-task pattern recorded here as an option is pursued for DM tasks in [ADR 0021](0021-dm-tasks-as-background-child-conversations.md).

A subagent becomes a child conversation that its `subagent` tool call owns, in the same pi-durable Harness and office storage as its parent. Pi then owns what mikan builds by hand today: the child's loop, retry, abort propagation, and idleness. A subagent may delegate to its own subagents down to a fixed depth, so the agent can hand work to a fresh copy of itself.

## Context

`runSubagent` starts every subagent in a separate `MikanAgentSession` over `SessionStore.inMemory()`: a separate in-memory pi-durable Harness with compaction disabled, discarded when the run ends. It predates [ADR 0017](0017-pi-durable-harness.md), when the core harness had no notion of a child conversation, and the research behind that ADR already recorded that mikan's subagents are not pi-durable's owned child conversations.

Because the child lives outside the parent's Harness, mikan rebuilds the relationship between them itself:

- **Nesting is forbidden.** An `AsyncLocalStorage` depth counter rejects any `runSubagent` call made inside a subagent with `Nested api.subagent.run calls are not allowed`. The DAG mode of the `subagent` tool is the only way to compose work, and it is planned by the parent in one call.
- **Abort and timeout are reimplemented.** A terminal-signal state machine, a 100 ms abort grace period, and a detached cleanup promise translate the parent's signal into the child's abort, then report usage after the child settles.
- **The child is invisible.** Its transcript never reaches storage, so Session View, the `history` tool, and an operator debugging a bad answer cannot see what a subagent did.
- **Memory capture reuses the same path for a single model call.** Memory capture ([ADR 0011](0011-capture-durable-knowledge-after-runs.md)) runs `runSubagent` with no tools and `maxTurns: 1` to get one structured answer.

pi-durable provides the relationship directly. A tool creates a conversation inside `api.commit()` with `ownership: { kind: "task", taskId: api.taskId }` and drives it through `api.conversation(id)`. The child starts as a copy of its owner conversation's agent; aborting or failing the call aborts the child; the parent is idle only once the child is; and a `replay: "safe"` call finds the same child after a restart through the ownership index.

### Measurements

All measurements ran outside `src/` against pi-durable 1.0.2 and pi-agent-core 1.0.2 with pi-ai's faux provider, so they exclude model latency.

| Question                                         | Result                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework time of one no-tool subagent run today | 0.21 ms p50, 0.44 ms p95 (2,000 runs). Negligible next to a model call; performance is not a reason for this change.                                                                                                                      |
| Heap growth of repeated `runSubagent` calls      | About 0.65 KB per run, linear over 8,000 runs. `SessionStore.inMemory()` alone, closed or not, and core `Agent` alone show no growth, so the growth comes from the per-run session wrapper. Its cause was not isolated.                   |
| Recursive delegation with owned children         | A scripted model asked to delegate five levels deep created three child conversations and stopped at the configured depth limit of 3, where the child's agent had the subagent extension removed. Each level's answer reached its parent. |
| Abort propagation                                | With a root, a child, and a grandchild blocked in a tool, `root.abort()` aborted the grandchild's tool call (1 of 1). The submission settled `unanswered` with no live tasks left.                                                        |
| Storage cost                                     | About 6.5 KB of SQLite per child conversation with a 400-character answer and no tool output. Real subagents store their tool calls and results too.                                                                                      |
| Time per child in SQLite storage                 | About 2 ms per child conversation.                                                                                                                                                                                                        |

The alternative of running subagents on core `Agent` was examined and fails on tools: every mikan tool, including the sandbox coding tools from `@earendil-works/pi-durable/tools`, is a durable registration whose `execute(args, api, context)` reads its execution environment, progress, and details from `ToolExecutionApi`. Running those tools under core `Agent` needs a reverse adapter that emulates `ToolExecutionApi`, which copies Pi internals.

## Decision

1. **A subagent is a child conversation owned by its tool call's task**, created in the parent's office Harness with `tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })` and driven with `api.conversation(id).submit(...).wait(...)`. `runSubagent` no longer opens its own Harness.
2. **The `subagent` tool is `replay: "safe"`.** It looks up an existing child by `scanConversations({ ownerTaskId })` before creating one, and submits with `requestId` set to `subagent:<taskId>`.
3. **Delegation may nest up to depth 3.** The depth is stored with the child when it is created, not held in process memory. A child created at the limit gets its agent configured without the subagent extension, so the model is not offered a tool it cannot use. The `AsyncLocalStorage` guard is removed.
4. **Each child gets its own mikan extension**, configured at creation with the profile's system prompt, tool grant, model, and thinking level. A child never runs with the parent's extension, whose hooks are bound to the parent's session and budget tally.
5. **Budgets stay per subagent, and spend still folds into the parent.** A child's budget hooks belong to its own extension. The parent's tally adds the child's spend from the child conversation's usage document when the call settles.
6. **The process-wide `SubagentSlotPool` stays, but a subagent releases its slot while it waits for its own children.** Ownership bounds lifetimes, not concurrency, so a busy office could otherwise multiply the per-run limit. Holding a slot across a wait deadlocks nesting: when every slot belongs to a parent waiting for a child, no child can start.
7. **Memory capture extraction calls the model once directly** through `pi-ai` and validates the result against its schema, because it needs no loop, tools, or transcript.

## Considered Options

- **Owned child conversations in the office Harness (chosen):** hands loop, retry, abort, and idleness to pi-durable through its documented API, makes subagent work inspectable, and allows nesting without a process-wide guard. It costs storage and needs the extension separation in decision 4.
- **Keep the per-run in-memory Harness and allow nesting:** the smallest change, but keeps the hand-built abort state machine, the invisible transcripts, and the per-run heap growth, and still runs a second Harness per subagent.
- **Run subagents on core `Agent`:** the lightest runtime, but every mikan tool is a durable registration, so it needs a reverse adapter that emulates `ToolExecutionApi`. That copies Pi internals, which the design rules forbid, and gives up pi-durable's retry.
- **Persistent, addressable subagents** (pi-durable's background pattern, where a child outlives the call and can be messaged later): a larger product change that this decision does not need. Owned children keep that path open.

## Consequences

- Subagent transcripts are stored in the office's `sessions.db` and kept as long as the storage keeps everything else ([ADR 0018](0018-one-durable-storage-per-office.md)). At about 6.5 KB per child before tool output, growth must be measured against production subagent volume before acceptance.
- Session View can show a subagent's work under the call that started it, through the child's conversation ID in the call's details. Session listing and the `history` tool read only the session index, so child conversations do not appear there as sessions.
- After a restart, the unfinished ownerless tasks that mikan aborts on open take their owned children with them, so recovery behavior does not change.
- The terminal-signal state machine, the abort grace period, the detached cleanup path, and the depth guard in `src/harness/subagent.ts` are removed. `hydrateSchema` stays, because `outputSchema` still arrives as plain JSON in tool arguments.
- A model can now delegate recursively. Depth 3 with at most 4 concurrent children per call allows at most 84 live subagents per top-level call before the global slot pool applies.

## Open questions before acceptance

- Does a child created by `createConversation` inherit its owner's extensions in a way that runs the parent's `mikan.<conversationId>` hooks before decision 4 replaces them in the same commit?
- Can a child's budget hooks stop it as precisely as `MikanAgentSession` stops a run today, including on time?
- How many subagent runs and how many bytes of tool output does production generate per office per month? `recordSubagentOutcome` already counts runs.
- Does the `subagent` tool's DAG mode keep its current semantics when each node is an owned child?
- Where does the slot release in decision 6 hook in: around the nested `subagent` call's wait, or by counting only subagents that are generating or running tools?
