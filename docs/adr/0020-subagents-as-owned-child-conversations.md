---
status: accepted
---

# Subagents run as task-owned child conversations of the office Harness

First rejected because today's subagents worked and users would see no change. Accepted once [ADR 0027](0027-interrupted-runs-continue-after-restart.md) let interrupted runs continue after a restart: a subagent in a separate in-memory Harness is lost on every restart, while an owned child conversation continues with its parent. The decision below replaces the first draft's nesting and per-child extension.

A subagent becomes a child conversation that its `subagent` tool call owns, in the same pi-durable Harness and office storage as its parent. Pi then owns what mikan builds by hand today: the child's loop, retry, abort propagation, idleness, and continuation after a restart.

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

1. **A subagent is a child conversation owned by its tool call's task**, created in the parent's office Harness with `tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })` and driven with `api.conversation(id).submit(...).wait(...)`. Its transcript stays in the office storage.
2. **The `subagent` tool is `replay: "safe"`.** Each task or DAG node records its child under `api.memo("subagent:<callId>:<node>")`, and submits with that string as its `requestId`, so a rerun after a restart finds the same child and the same submission.
3. **The child keeps the extension it copies from its owner**, as pi-durable's foreground subagent example does. Its configuration at creation narrows it to the profile: `tools` and `modelTools` list the granted tools, `instructions` carries the profile prompt, and the profile's model and thinking level apply. The owner session's `mikan` and `mcp_servers` sections and its hooks act only on the owner's own conversation ID, so the child sees only its instructions. Because a continuing parent reinstalls its extension before the Harness resumes, the child resumes with its tools after a restart.
4. **Budgets stay per subagent.** The subagent tool registers the child's hooks with the owner session by conversation ID (`MikanAgentSession.trackSubagent`). They count turns before each request, block further tools once a response reaches the turn, token, or cost limit, and abort the child on its duration limit. Until a rerun registers them again after a restart, the child runs without its own budget.
5. **Spend folds into the parent through Pi's tool usage.** The tool result's `usage` is the children's total from their usage documents, so it lands in the parent's `pi.usage.tools` and session spend. The parent's request tracking counts only requests carrying its own provider session ID, so a child's requests do not consume the parent's call budget.
6. **Nesting stays forbidden.** The child's tool grant comes from its profile, which cannot name `subagent`. The process-wide `SubagentSlotPool` still bounds concurrent subagents.
7. **Memory capture** still uses the in-memory `runSubagent` until it calls the model once directly; that path is removed then.

## Considered Options

- **Owned child conversations in the office Harness (chosen):** hands loop, retry, abort, idleness, and continuation after a restart to pi-durable through its documented API, and makes subagent work inspectable. It costs storage.
- **A separate extension per child (the first draft):** keeps the parent's hooks off the child by construction, but the child's extension exists only after its tool call reruns, so a child resumed after a restart runs with no tools. A trial showed exactly that: the resumed child's request removed every tool.
- **One fixed mikan extension per office, dispatching by conversation ID:** also survives a restart, but needs a dispatch layer and a merged tool list across sessions; decision 3 gets the same result from Pi's default copy.
- **Keep the per-run in-memory Harness and allow nesting:** the smallest change, but keeps the hand-built abort state machine, the invisible transcripts, and the per-run heap growth, and still runs a second Harness per subagent.
- **Run subagents on core `Agent`:** the lightest runtime, but every mikan tool is a durable registration, so it needs a reverse adapter that emulates `ToolExecutionApi`. That copies Pi internals, which the design rules forbid, and gives up pi-durable's retry.
- **Persistent, addressable subagents** (pi-durable's background pattern, where a child outlives the call and can be messaged later): a larger product change that this decision does not need. Owned children keep that path open.

## Consequences

- Subagent transcripts are stored in the office's `sessions.db` and kept as long as the storage keeps everything else ([ADR 0018](0018-one-durable-storage-per-office.md)), at about 6.5 KB per child before tool output.
- Session View can show a subagent's work under the call that started it, through the child's conversation ID (`runId` in the call's details). Session listing, task listing, and the `history` tool read only the session index, so child conversations do not appear there.
- A restart no longer loses a running subagent: `planContinuation` keeps unfinished conversations whose owner chain reaches a continuing session, and a child's model and sandbox calls resolve to that session's binding.
- Session spend now includes subagent spend; before, it reached only the run's in-memory tally.
- Progress activity comes from the child's hooks: `thinking` before each request and the tool name and label before each call. The previous `writing · N chars` activity is gone.
- Granted tools keep the owner's registrations, so their descriptions still mention `codemode` although a child has no `codemode` tool.
