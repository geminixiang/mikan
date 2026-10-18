---
status: accepted
---

# Keep only a single-task subagent

The `subagent` tool now takes one self-contained task and runs it in a child conversation with the parent's model and tools; only the child's final answer returns to the parent. Profiles, parallel batches, DAGs, the progress dashboard, the per-child budget and timeout, and the Slack persona posting are removed. This supersedes [ADR 0020](0020-subagents-as-owned-child-conversations.md) where they differ; the child is still a task-owned conversation in the office Harness.

## Context

The tool was introduced for three things: keep the parent's context small by letting a child investigate, finish faster and more completely through parallel and DAG work, and run in the background while a person keeps using the agent.

[docs/research/delegation-cost-2026-10.md](../research/delegation-cost-2026-10.md) measured the second and third on real tasks with a local daemon and real Slack:

| Task                                         | Direct                          | Parallel subagents                          |
| -------------------------------------------- | ------------------------------- | ------------------------------------------- |
| Three repositories, 14 facts, channel        | 67 s, 14/14 in every run, $0.04 | 148 s, 12–14 of 14, $0.12                   |
| Three 90-second waits                        | 100 s when batched, $0.018      | 108 s, $0.026–0.081                         |
| Same three repositories, sandbox CPU and RAM | 124 s one after another         | 316 s at once, one `npm install` OOM-killed |

Parallel children share one office sandbox (one CPU and 512 MB in production), so CPU- and memory-bound work runs slower in parallel; waits already overlap because pi-durable runs one turn's tool calls in parallel. The tool never ran in the background: the parent waits inside the tool call. `start_task` ([ADR 0021](0021-tasks-as-background-child-conversations.md)) is what frees a direct message.

The first goal holds in production. Over 28 days, 187 subagent calls read a median of about 56k tokens and returned a median of about 190; the parent then ran a median of 13 more requests without compaction. Had the parent done the work, it would have carried that context through the child's turns and every later request, an estimated $24 and $37 against $42 the children cost and about $573 total spend (the estimate leans high; see the research doc). Isolation pays for large investigations; the eval's small tasks did not show it.

Also in production, 44% of those calls ended without an answer: 40 hit a profile's token cap and 37 the 10-minute timeout, returning one error line after the spend.

## Decision

- `subagent` takes `task` (and the required `label`). The child gets the parent's model and every tool the parent has except `subagent`, `start_task`, and `task_status`, without `codemode` and `tool_search`. Its instructions say it works for another agent, name its tools, and say only its final message returns.
- No profiles, batches, DAGs, structured output, parent-context snapshot, budget, or timeout. The child ends when it answers or when the parent's run is stopped; its spend is the tool result's usage, as before.
- The tool shows as an ordinary step in the run's checklist.
- Slack's `chat:write.customize` scope stays in the app manifest: removing a scope changes an installed app, and it can go with the next scope change.

## Consequences

- Several `subagent` calls in one turn still run at the same time, sharing the sandbox; the tool description says so and leaves the choice to the model.
- A runaway child is stopped only by stopping the parent, like a chat run; a scheduled event's budget does not reach inside a child.
- `<workspace>/agents/*.md` profiles are ignored. The directory stays a reserved workspace name so it is never read as an office.
- `ConversationResponder` loses the optional `replaceSubagentProgress` and `respondAsRole`, and `Workspace` loses `agentsDir`; an embedder that set or read them must drop them.
