# An `agent()` function for codemode scripts — 2026-10

## Conclusion

Not adopted. A codemode-only `agent()` that runs a self-contained task in a fresh conversation lets a script fan out over many documents, and it completed every run when the user asked for that. The model never called it on its own, with or without guidance in its description, so as a capability the model chooses it adds nothing. The failures it would fix come from the model stopping early after a search misses, which is a separate problem.

## Question

[ADR 0028](../adr/0028-retire-the-subagent-tool.md) removed the model-facing `subagent` tool because the model delegated too readily and at about twice the cost. Pi's own subagent example (`packages/durable/test/examples/22-subagent-foreground.ts`) and the workflow scripts of `@tintinweb/pi-subagents` suggest another shape: delegation that only a script can start, so the model has to write the fan-out explicitly. Does that help on tasks where direct work fails?

## Setup

- Prototype: the single-task child conversation from ADR 0028's measurements, renamed `agent`, registered with `callers: ["tools"]` so only codemode scripts can call it. The child gets the parent's model and tools minus `agent` and the task tools.
- Local daemon, test Slack workspace, one GPT-class model through a local proxy, sandbox with 1 CPU. A fresh private channel per run; the request is posted in a thread so `start_task` does not apply.
- Fixtures: incident reports of about 20 KB each, written as chat timelines (`11:08 frank: checking replica lag on edge-2, it is at 8 seconds.`), with three fact sentences per report whose wording varies and which carry decoys (other services, a rejected cause, a second minute figure).
  - **many**: 16 reports; one line per report with service, cause, and minutes. Complete means 16/16.
  - **refute**: 12 reports whose opening summary states a cause; 4 are contradicted later. List only the contradicted ones. Complete means 4/4 without false positives.
  - **short**: 2 reports, one line each, to detect needless delegation.
- Grading: `regrade` accepts cause names in Chinese or English and ignores progress labels. Cost uses $1.25 / $0.125 / $10 per million fresh input, cached input, and output tokens.

## Results

| Setup                                                                                              | many complete | refute complete | short | USD per run |
| -------------------------------------------------------------------------------------------------- | ------------- | --------------- | ----- | ----------- |
| `main`, no hint                                                                                    | 0/6           | 4/6             | 3/3   | 0.03–0.08   |
| `main`, user asks for a codemode script                                                            | 2/3           | 2/3             | —     | 0.07–0.09   |
| `agent()` available, plain description                                                             | 0/3           | 0/3             | —     | 0.03–0.13   |
| `agent()` with guidance on when to fan out                                                         | 3/9           | 3/3             | 3/3   | 0.03–0.08   |
| `main` plus a prompt line: grep finds exact words only, read before concluding something is absent | 0/3           | 2/3             | 3/3   | 0.03–0.09   |
| User asks to give each report to `tools.agent()`                                                   | 3/3           | 3/3             | —     | 0.13–0.27   |

- Without a user request the model called `agent()` in none of 21 runs. The guided description's three complete runs used plain shell commands; 3/9 against 0/12 for the other setups is not significant at this size (Fisher p ≈ 0.06).
- When asked, per-report agents completed 6 of 6 runs in similar wall time (29–80 s), at 3–4× the cost of direct work.
- No setup delegated on the short task.
- Every incomplete run ended the same way: a search for expected words missed the varied phrasing, and the model answered that the reports had no conclusion section or marked fields "unknown" instead of reading further.

## Consequences

- No `agent()` function. The measured benefit exists only when a user explicitly asks for fan-out, which a person can also get by asking for a background task per item.
- Early stopping after a missed search is the failure worth studying next; a prompt line stating the limitation did not fix it.

## Side finding

With nerdctl as the container engine, every public office's directory is mounted read-only into every sandbox (`src/office/projection.ts`, [ADR 0008](../adr/0008-office-visibility-replaces-door-policy.md)), and nerdctl records all mounts in one container label capped at 4096 bytes. Locally, sandbox creation failed for every office once about 25 public channels existed (nerdctl 2.3.1); Docker 29.5 accepted 40.
