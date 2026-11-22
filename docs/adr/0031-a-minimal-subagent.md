---
status: accepted
---

# A minimal subagent

mikan offers a `subagent` tool again, in one form: hand over one task, get the answer back. This supersedes the removal in [ADR 0028](0028-retire-the-subagent-tool.md); its measurements stand, and its finding that delegation costs more than doing the work is now stated to the model in the tool's description.

## Context

ADR 0028 removed the tool on measurements: delegated work was slower, cost more, and was no more correct than the conversation doing it. A deployment in use then showed the tool called on most days, almost always as one task with a label and a built-in profile. Nothing used the DAG, per-call budgets, output schemas, the progress dashboard, or profile files ([docs/research/subagent-minimal-2026-11.md](../research/subagent-minimal-2026-11.md)). The owner decided to keep what people use and nothing else: one level, a small cap on how many run at once, and no orchestration.

pi-durable documents the pattern for exactly this: a tool that creates a child conversation owned by its own task, submits the task, and returns the answer.

## Decision

- `subagent { label, task }` creates a child conversation owned by the call (`src/harness/tools/subagent.ts`), following pi-durable's foreground pattern. The child is given the parent's system prompt followed by a short section saying what it is, and the task as its only message.
- **One level.** The child's tools are `read`, `bash`, `edit`, and `write`, and it selects the parent's extensions without codemode and tool search. It has no `subagent` to call and no script or search that could reach one.
- **At most four children run at once in an office**, because every child of an office shares one sandbox's CPU and memory. Further calls wait their turn; a wait ends when the run is stopped. The pool belongs to the office's session storage, the one object every runner of an office shares.
- **Bounds.** A child takes at most 100 tool rounds (`maxTurns`). Stopping the run stops its children, since the call owns them. A child's model spend is returned as the tool result's `usage`, the path `jev` already uses, so the session's usage summary and budget count it when the call returns.
- **Restart.** The call is replay-safe: a run interrupted while a child works finds the same child and waits for it. For that, the session storage keeps a child whose owner is being continued, and finds the owner's models and execution environment for a child's requests. The lookup is one hop, because a child cannot have children.
- Not restored: profiles and `<workspace>/agents/`, DAGs and dependencies, per-call budgets and timeouts, output schemas, the progress dashboard, posting under a profile's name, and subagent telemetry.
- The prompt gains no section about subagents. The tool's description says that a subagent starts cold, rereads what the conversation already knows, and shares the sandbox, and that it is for keeping a large, separable investigation out of the conversation's context.

## Options considered

| Option                                                       | Why not                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stay with ADR 0028: no tool                                  | People use it daily; its absence is not something they would barely notice.                                                                        |
| Restore the removed tool                                     | About 1,700 lines for features nothing called.                                                                                                     |
| Give the child every tool but `subagent`                     | A child bound to the parent's message could post, react, attach, and schedule events, which no profile allowed, and codemode could reach any tool. |
| A cap per session or per process                             | The shared resource is the office's sandbox; a per-session cap lets two threads of one office run eight, and a per-process cap makes offices wait. |
| Bind each child to the parent's session when the call starts | A restart resumes the child's request before the call runs again, and the request fails with no binding. The owner has to be known to the storage. |

## Consequences

- A conversation can delegate again, to at most four children at a time, none of which can delegate.
- A child that needs the web, an MCP server, or a scheduled event cannot do it; it reports back and the conversation does that part.
- The cost ADR 0028 measured is unchanged. If the model delegates what it should do itself, the description is the lever, then the tool's removal.
- The session storage again knows which conversation owns which: about 40 lines that the simplification survey removed with the old tool.

## Removal condition

Checked on 2027-02-22 from production tool counts: if `subagent` was called fewer than 30 times in the previous 30 days, remove the tool and the owner lookup. The remaining path is the one ADR 0028 describes: the conversation does the work itself.
