# Removing memory capture (2026-11)

Question: should mikan keep Memory capture ([ADR 0011](../adr/0011-capture-durable-knowledge-after-runs.md)), the background step that asks Jev after each settled human run whether the user stated durable knowledge and then asks the office's model to add stamped lines to `MEMORY.md`?

Sources: `src/memory-capture/`, `src/runtime/conversation-runtime.ts`, `src/main.ts`, ADRs 0010–0012, a production deployment's daemon log, and the acceptance eval in `.workspace/memory-capture-eval/`.

## What it costs

- Every settled human run makes one Jev request; a third of runs (ADR 0011's gate rate) add a model request on the office's provider carrying the whole `MEMORY.md`. Neither shows in the run's usage line.
- It is a second writer of `MEMORY.md`. ADR 0011 accepted a window in which an agent edit can be lost, and the captured lines arrive in a section the agent did not write.
- It fails silently. In one production deployment the Jev provider's account had no credits from a configuration change onward: about 350 Jev requests returned HTTP 402 over eight days, most of them memory captures, each logged only as a host-side warning. Nobody using the conversations could see that nothing was being remembered.

## What replaces it

| Need                                       | Owner                                                     |
| ------------------------------------------ | --------------------------------------------------------- |
| Policy: standing rules, preferences, facts | The agent edits `MEMORY.md` during the run                |
| Episodic memory: what happened, when       | The long-lived session, kept within context by compaction |
| Recall from an earlier session or `/new`   | The `history` tool (`sessions`, `search`, `read`, `chat`) |

## Accepted regression

ADR 0011 and ADR 0012 measured that the agent alone writes rarely: it wrote `MEMORY.md` in 6% of runs with explicit "from now on" language, and capture raised coverage of stated knowledge from about 6% to 48% in a replay. Without capture, a rule the agent does not write down survives only in its session (and its compaction summary) and in `history`; a new thread or `/new` session finds it only by searching. This is the trade-off accepted for one writer and no hidden model calls.

## Dependents

- Code: the `src/memory-capture/` module, `ConversationRuntimeOptions.memoryCapture` (public package interface), its call in `conversation-runtime.ts`, the composition in `main.ts`, the `memory_capture` Jev caller in observability, and its tests.
- Jev stays: Slack auto-reply, DM task intent, and the `jev` and `jev_browser` tools still use it.
- Existing `## Captured knowledge` sections in `MEMORY.md` files stay as written; they are ordinary policy lines from then on.

## Acceptance eval

| Case                                                | Before                | After                 |
| --------------------------------------------------- | --------------------- | --------------------- |
| M1 `MEMORY.md` rewritten after a run stating a rule | yes, 1 captured line  | no                    |
| M2 extra calls per run                              | Jev 1, model 1        | 0, 0                  |
| M3 warnings over two runs with Jev out of credits   | 2 (2 Jev calls)       | 0 (0 Jev calls)       |
| M4 the agent writes `MEMORY.md` itself              | yes                   | yes                   |
| M5 a `/new` session sees `MEMORY.md`                | yes                   | yes                   |
| M6 `history` search finds the session before `/new` | yes                   | yes                   |
| M7 captured lines written before the upgrade        | kept, seen, unchanged | kept, seen, unchanged |
