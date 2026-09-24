---
status: accepted
---

# Remove Dream

The scheduled Dream maintenance is removed. Conversation `MEMORY.md` is written only by the agent during runs and by Memory capture after them ([ADR 0011](0011-capture-durable-knowledge-after-runs.md)). No scheduled process reads session history or rewrites the anchor.

## Context

Dream swept every registered office nightly, read session entries after a per-session checkpoint in bounded batches, and replaced the whole `MEMORY.md` with a model-generated anchor. It existed to carry knowledge across session boundaries, most importantly across biweekly rotation.

- ADR 0010 removed rotation, so top-level sessions no longer lose context on a schedule.
- ADR 0011 records durable knowledge at the moment a user states it.

Production evidence from the weeks after Dream was enabled:

- About 83% of session entries had never been read. Among offices active in the last week, the median age of the newest evidence Dream had read was 27 days, and the backlog grew faster than nightly sweeps could drain it.
- About one attempt in five failed. Most failures were the 120-second generation timeout. Offices with an unusable model configuration failed and were retried every night.
- Each success rewrote the whole anchor. Text the agent had just written was usually reworded, and the prompt asked the model to prefer the supplied evidence, which was often weeks older than the memory it replaced.

A local replay of 1,882 human runs across eight offices, judged by a panel of four models from two vendors:

- The production `MEMORY.md` files, including Dream's output, covered about 6% of the durable knowledge users stated during the period.
- With Memory capture added, coverage rose to about 48%.
- In a new-session behavior test, adherence to the stated knowledge rose from 18% to 44%.

## Considered Options

- **Remove Dream (chosen)** — its remaining purpose after ADRs 0010 and 0011 is consolidation, which it performs by rewriting from stale evidence, at nightly cost, with a fifth of attempts failing.
- **Keep Dream as a consolidator** — keeps the backlog, the timeouts, and the stale-evidence rewrite that ADR 0011 had to work around with a prompt rule.
- **Replace Dream with size-triggered consolidation** — addresses growth, but the replay grew memory by about 0.6k characters per busy office per week. There is no measured size problem yet, and building it now would be speculative.

## Consequences

- `src/dream/`, the scheduler, `ConversationRuntime.runDream`, and the Dream checkpoint are removed. The office maintenance barrier remains for `/new`.
- Existing `<state-dir>/conversations/<office-key>/dream.json` files are no longer read. They are inert host-private data that operators may delete.
- Existing `MEMORY.md` content, including anchors Dream wrote, stays as it is and continues to be loaded into prompts.
- Nothing shortens `MEMORY.md` automatically. If growth becomes a measured problem, consolidation should be added as a size-triggered operation that edits memory in place rather than regenerating it from session history.
- The system prompt no longer promises that a later Dream revises memory; the agent and Memory capture are the only writers.
