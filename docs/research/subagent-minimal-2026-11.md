# A minimal subagent (2026-11)

ADR 0028 removed the `subagent` tool. A deployment in use then showed it called on most days, so the owner keeps a weakened form: one level, a small cap on how many run at once, and no orchestration. This page records the research; the decision goes in an ADR once the open points below are closed.

## How the removed tool was used

Read from a deployment's logs over a month, without content:

- Almost every call was one `task` with a `label` and a built-in profile, mostly `software-engineer`. No call used a DAG or dependencies, and no workspace had a custom profile in `agents/`.
- Calls rarely overlapped: two in the same minute happened about once in two hundred.
- The built-in `software-engineer` and `worker` profiles gave the child `read`, `bash`, `edit`, `write`, and `jev`, a prompt of three paragraphs, and limits of 100 turns, one million tokens, and ten dollars.

So the DAG, per-call budgets, output schemas, the progress dashboard, the profile files, and posting as a profile's persona were unused. What people depended on is "hand over one task, get the answer back".

## What Pi offers

pi-durable 1.5.2 documents the foreground pattern (README, "Abort and Subagents"; example `21-subagent-foreground.ts`): the tool creates a child conversation owned by the call's task inside `api.commit()`, submits the task as input with a request ID derived from the task ID, waits, and returns the answer. With `replay: "safe"` a rerun after a crash finds the same child through the ownership index. Aborting the call aborts the child, and the parent is idle only once the child is.

`configure()` on the child takes `tools` and `modelTools` as tool registrations (not names), `extensions: { remove }`, `instructions`, and `maxTurns`, a Pi-native bound on tool rounds.

## Prototype

`.workspace/subagent-minimal-eval/subagent.eval.ts` runs a prototype of the tool as a platform tool pack, through the Slack bot and the conversation runtime with Pi's faux provider.

| #   | Question                                                         | Result                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Does the documented pattern create a child from a mikan session? | Yes, in 4 ms. `tools` given as names fails with "Value contains a non-JSON undefined"; they must be the registrations, found by name in `api.registry.tools()`.                                                                                   |
| P2  | Can the child call the model?                                    | No. Its request faults with "Provider request has no active session binding": the office storage routes a provider request to the session bound to that provider session ID, and a child has its own.                                             |
| P3  | What did the removed tool do about it?                           | `session-store.ts` recorded each child's owner when the conversation was created and looked bindings up through the owner, for model requests and for the execution environment. The simplification survey removed that with the tool (6a3f8c84). |
| P4  | What does the child's system prompt contain?                     | Not the mikan section: it is rendered only for the session's own conversation, as are the budget, abort, and compaction hooks. The child needs its instructions passed to `configure()`.                                                          |

## Consequences for the design

- The tool itself is small, but a child needs the owner lookup back in the office storage: one hop, since a child cannot delegate.
- The child's model spend must reach the session's usage and budget, and a stop must end the child. Both are scoped to the session's own conversation today.
- The child gets `read`, `bash`, `edit`, and `write`: what almost every call had. Without `subagent`, codemode, or tool search among its tools, one level holds by construction.

## Open points

1. Budget and stop: how a child's model calls are counted and cut off; whether `maxTurns` alone bounds a runaway child.
2. Restart in the middle of a child: the parent resumes once, the child is neither rerun nor presented as its own run.
3. Where child conversations appear: the session viewer, admin, `/session`, history sync, idle disposal, `/new`.
4. The cap: four per office needs state shared across runners, with a wait that ends on abort.
5. Delegation should not grow: ADR 0028 measured that a simpler tool made the model delegate more. The description states the costs, no prompt section is added, and the eval compares cost against doing the work directly on a real model.
