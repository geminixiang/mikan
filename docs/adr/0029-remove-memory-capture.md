---
status: accepted
---

# Remove memory capture

Memory capture is removed. Conversation `MEMORY.md` is policy, written only by the agent during a run; episodic memory is the session itself and the `history` tool that searches earlier sessions. This supersedes [ADR 0011](0011-capture-durable-knowledge-after-runs.md).

## Context

ADR 0011 added a background step after each settled human run: Jev judged whether the user stated durable knowledge, and the office's model added stamped lines to `MEMORY.md`. [docs/research/memory-capture-removal-2026-11.md](../research/memory-capture-removal-2026-11.md) records what it cost:

- A hidden Jev request on every human run and a model request on about a third of them, outside the run's usage.
- A second writer of `MEMORY.md`, with a window in which an agent edit could be lost.
- Silent failure: in one deployment every capture failed for eight days because the Jev account had no credits, and only the host log showed it.

Meanwhile the session became durable memory on its own: top-level sessions are long-lived and compacted by Pi (ADR 0010, ADR 0017), every earlier session stays in the office storage (ADR 0018), and the `history` tool searches and reads it.

## Decision

- Remove the `src/memory-capture/` module, its call after each run, and `ConversationRuntimeOptions.memoryCapture`.
- `MEMORY.md` holds policy: standing rules, preferences, and durable facts. Only the agent writes it, during a run.
- What happened, and when, is found in the session and through `history`.
- Existing `## Captured knowledge` lines stay as they are, as ordinary policy lines.

## Considered Options

- **Remove it (chosen):** one writer, no hidden model calls, nothing that fails out of sight.
- **Keep it and surface failures:** fixes the silence but keeps the hidden calls and the second writer.
- **Keep it on a cheaper or more reliable judge:** same, and still makes the remembering decision for the model.

## Consequences

- ADR 0011 measured that the agent alone records stated knowledge rarely; without capture, a rule it does not write down reaches a new thread or `/new` session only when the model searches `history`. This regression is accepted.
- Each human run costs one Jev request and up to one model request less.
- An embedder that passed `memoryCapture` to `createConversationRuntime` must drop it.
