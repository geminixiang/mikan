---
status: accepted
---

# Retire the subagent tool

mikan no longer offers the `subagent` tool. A conversation does the work itself; Pi already runs the tool calls of one turn at the same time, and a Slack direct message still hands long work to a background task (`start_task`, [ADR 0021](0021-tasks-as-background-child-conversations.md)). This supersedes [ADR 0020](0020-subagents-as-owned-child-conversations.md).

## Context

[docs/research/delegation-cost-2026-10.md](../research/delegation-cost-2026-10.md) measured delegation on real tasks with a local daemon and real Slack, and the mechanism alone with a scripted model:

| Task                                         | Direct                          | Subagents                                   |
| -------------------------------------------- | ------------------------------- | ------------------------------------------- |
| Three repositories, 14 facts, channel        | 67 s, 14/14 in every run, $0.04 | 148 s, 12–14 of 14, $0.12 (three parallel)  |
| Three 90-second waits, channel or DM         | 100 s when batched, $0.018      | 108 s, $0.026–0.081                         |
| Same three repositories, sandbox CPU and RAM | 124 s one after another         | 316 s at once, one `npm install` OOM-killed |

Parallel subagents share one office sandbox and its CPU and memory limits, so CPU- and memory-bound work competes for the same resources instead of finishing sooner. Waits and network calls already overlap without subagents, because pi-durable executes one turn's tool calls in parallel by default (`toolExecution: "parallel"`). Each child also starts a new conversation that misses the provider cache for the system prompt. Two prompt lines stating these facts did not stop the model from delegating.

The remaining reason for the tool, keeping a large investigation out of the parent's context, did not hold either (experiment 7 of the research doc). In production the parent's context grew a median 0 tokens per run without a subagent (p90 18.8k), while children read a median 56k because they start without context. A single-task subagent kept for isolation cost about twice as much in the lab without making later prompts smaller, and the simpler tool made the model delegate more often. This matches Pi's own choice to keep subagents out of its core.

Production used the tool: 269 calls in 32 offices over the last 28 days, nearly all with built-in profiles (`software-engineer`, `data-scientist`, `worker`). Custom profiles under `<workspace>/agents/` existed in one office and were not called in that period.

## Decision

- The `subagent` tool, its profiles (built-in and `<workspace>/agents/*.md`), its slot pool, its progress dashboard, the Slack persona posting for a profile's final answer, and the subagent telemetry are removed.
- `start_task` stays as the way to keep a direct message free during long work.
- Slack's `chat:write.customize` scope stays in the app manifest for now: removing a scope changes an installed app, and it can go with the next scope change.

## Consequences

- A conversation that delegated now does the work in its own session, in its own context. The measured tasks finished as fast or faster, as correct or more, and cheaper.
- Work that is truly long and independent in a channel has no background option; a direct message's `start_task` covers it until a channel needs one.
- A `<workspace>/agents/` directory is ignored. It stays a reserved workspace name so an existing directory is never read as an office.
- `ConversationResponder` loses the optional `replaceSubagentProgress` and `respondAsRole` methods, and `Workspace` loses `agentsDir`; an embedder that set or read them must drop them.
