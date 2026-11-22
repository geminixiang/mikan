# A minimal subagent (2026-11)

ADR 0028 removed the `subagent` tool. A deployment in use then showed it called on most days, so the owner keeps a weakened form: one level, a small cap on how many run at once, and no orchestration. This page records the research; the decision is [ADR 0031](../adr/0031-a-minimal-subagent.md).

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

## Implementation findings

- `extensions: { remove }` in `configure()` edits the host's default selection, not the owner's: the child ended up with no extension and no tools. The child's extensions are the owner's stored selection (`AgentDoc`) without codemode and tool search, as an array.
- Binding a child when the call starts is too late after a restart: the child's request resumes before the call runs again and fails with no binding. The storage records the owner when the child is created (`conversationCreated`) and again when a restart keeps it.
- A restart aborted the child: unfinished work is kept only for conversations in the session index. A child is kept when its owner is.
- A child's spend returned as the tool result's `usage` reaches the session's usage and budget with no other change; `jev` already does this.

## Acceptance eval

`.workspace/subagent-minimal-eval/subagent.eval.ts` drives the Slack bot and the conversation runtime with Pi's faux provider. Baseline is `main` at aa841b2d, where the model's call to `subagent` returns "Tool subagent is not available".

| Case                                         | Baseline           | Expected                                   | After                                         |
| -------------------------------------------- | ------------------ | ------------------------------------------ | --------------------------------------------- |
| S1 One task delegated                        | Tool not available | The child's answer is the tool result      | The child's answer is the tool result         |
| S2 The child calls `subagent`                | Tool not available | Refused; no third conversation             | "Tool subagent is not available" in the child |
| S3 Six tasks in one turn                     | Tool not available | At most four children at once; six answers | Four at once; six answers                     |
| S4 `stop` while a child works                | Stops (no child)   | Idle at once, no further model call        | Idle in 6 ms, no further model call           |
| S5 Child writes about 1,000 output tokens    | Not counted        | Counted in the run's usage                 | 1,014 output tokens in the usage summary      |
| S6 Sessions listed for the office afterwards | One                | One: the child is not a session            | One                                           |

`src/test/subagent-tool.test.ts` covers the same at the session level, and a restart in the middle of a child: the run resumes the same child, which is asked once, and the parent receives one answer. `src/test/agent-runner.test.ts` runs a child's `bash` in the conversation's execution environment.

## Verification on Slack

A local daemon built from this change, on the `oci` sandbox, answered a direct message on a real Slack workspace that asked it to delegate: the model called `subagent`, the child created a file in the office's container and reported its path in 4.1 s, and the conversation then read the file itself with `bash`. The run cost $0.0019 on the model the Slack E2E uses. The same task done directly was not measured again; ADR 0028's comparison stands.

## Open points

1. A child's spend is counted when the call returns, so a budget cannot cut a child off in the middle; `maxTurns` and a stop bound it.
2. A child conversation is not in the session index, so the session viewer, admin, and `/session` do not show its transcript. The parent's transcript has the call and its result.
3. Delegation should not grow: ADR 0028 measured that a simpler tool made the model delegate more. The description states the costs, no prompt section is added, and the eval compares cost against doing the work directly on a real model.
