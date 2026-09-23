---
status: accepted
---

# Capture durable knowledge after each human run

After a human-initiated run settles, mikan asks Jev whether the user established durable knowledge in that exchange. When the answer clears a threshold, the office's own model extracts the specific entries and mikan adds or updates them in the conversation `MEMORY.md`. Knowledge is recorded when it is stated instead of waiting for the nightly Dream, which runs weeks behind on active offices.

## Context

ADR 0010 removed biweekly rotation because Dream had not read most of the sessions it cut. Top-level sessions now keep their context through compaction, but knowledge still does not cross session boundaries: a new thread or a `/new` session starts with only `MEMORY.md`.

An offline study of a production snapshot (about 27,600 human-initiated runs over four and a half months) found:

- About one run in five establishes durable knowledge: a standing rule or prohibition, a delivery preference, a durable fact about systems or workflows, or a correction of a persistent misunderstanding. Keyword matching finds only about one in forty and has roughly one-third precision.
- The agent wrote `MEMORY.md` or a skill in only 6% of runs that used explicit "from now on" language. Of the knowledge extracted from a sample of runs, 51% was absent from the current conversation and global memory and another 25% was only partially present. Runs after Dream was enabled showed the same gap.
- Thread sessions account for about 39% of the explicit standing rules, and knowledge stated in one thread never reaches another.
- In one replayed conversation a user restated the same tool prohibition at least eight times over two months while it stayed out of memory; the replayed pipeline captured it the first time and treated every later restatement as a duplicate.

A proof of concept measured Jev as the gate against labels from a stronger model applied to the same rubric: ROC-AUC 0.95 on human-initiated runs, precision 0.90 and recall 0.79 at a probability threshold of 0.4, flagging about a third of runs. Each gate call costs about $0.00005 and takes under a second. Automated reminder and event messages produced most false positives.

## Decision

- Trigger on settlement of runs with stop reason `stop`, skipping scheduled-event runs. The capture runs in the background and never delays or blocks conversation work.
- Gate with Jev on the user message and the final assistant reply only; tool results are excluded because they multiply input size without adding user-established knowledge.
- Extract with the office's configured model, giving it the current `MEMORY.md` so it can skip duplicates and target updates. Secrets, transient state, one-off parameters, and assistant-only claims are excluded.
- Write only the conversation `MEMORY.md`, never workspace memory. Entries go under a `Captured knowledge` section as single lines stamped with the capture date and source message. Updates replace the line they supersede; nothing else in the file is rewritten.
- Captures are serialized per office and apply their operations to a fresh read of the file immediately before an atomic replace.
- When Jev is not configured, capture is disabled for the process.

## Considered Options

- **Post-run Jev gate plus targeted extraction (chosen)** — records knowledge at the moment it is stated, costs little, and adds or updates individual lines instead of rewriting the anchor.
- **Capture only at compaction** — compaction is rare (most sessions never compact) and does not cover the thread boundary where much of the knowledge is lost.
- **Extract with an LLM on every run without a gate** — about five times more model calls for the same recall.
- **Keyword gate** — about one-third precision and far lower recall than Jev.
- **Rely on the agent writing memory during the run** — the measured behavior this decision addresses.

## Consequences

- Conversation `MEMORY.md` grows by roughly one to three lines per active day in busy offices; the replay produced about 150 entries in two months, comparable to current Dream output. A size-triggered consolidation is still required and remains Dream's job until it is redesigned.
- Dream still rewrites the whole anchor nightly. Its prompt now keeps captured entries unless newer evidence contradicts them, because its evidence is often older than the capture.
- An agent edit to `MEMORY.md` that lands in the few milliseconds between the capture's fresh read and its atomic replace can be lost. This window is accepted; captures do not use the office maintenance barrier because that would block new work behind unrelated active runs.
- Captures in flight during shutdown are abandoned. Writes are atomic, so the file is never partially written, and the knowledge can be captured again when restated.
- Extraction adds model calls on the office's own provider for about a third of human runs, each carrying the current `MEMORY.md` as input.
- Users can still correct or remove captured entries by asking the agent, which edits `MEMORY.md` as before.
