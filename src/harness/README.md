# src/harness

mikan's model-facing integration of Pi 0.85.0's native `AgentHarness` and
`pi-ai` model catalog. Pi owns durable operations, the turn loop, tool execution,
message persistence, retries, compaction, and recovery. mikan supplies prompt
sources, authorized tools, per-request budgets, delegated-spend accounting, and
platform event translation. Platform adapters and Sandbox backends stay outside
this module.

## Files

| File                   | Authority                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `runner.ts`            | `MikanAgentSession`: native Pi integration, request budgets, delegated usage, and platform events |
| `session-store.ts`     | Pi v4 JSONL session ownership, native harness attachment, and inspection                          |
| `models.ts`            | model catalog and authentication resolution                                                       |
| `settings.ts`          | harness retry, compaction, and budget settings                                                    |
| `skills.ts`            | `SKILL.md` parsing, discovery, diagnostics, and prompt formatting                                 |
| `subagent-profiles.ts` | subagent profile discovery and validation                                                         |
| `subagent-runner.ts`   | bounded isolated subagent execution                                                               |
| `subagent-slots.ts`    | process-wide subagent concurrency slots                                                           |
| `usage.ts`             | usage aggregation and cost accounting                                                             |
| `event-format.ts`      | event-file payload schema shared by the event tool and watcher                                    |
| `http.ts`              | shared HTTP dispatcher configuration                                                              |
| `types.ts`             | exported harness and subagent types                                                               |
| `index.ts`             | harness module exports                                                                            |

`SessionStore` persists the current Pi 0.85.0 v4 JSONL format: a header with
`v: 4` and `storageVersion: 1`, followed by session mutations. mikan-specific
metadata is stored as the durable namespaced value `mikan/metadata`. Runtime
opening supports only this current format; legacy mikan v3 and Pi 0.84-generation
v4 files require `mikan sessions migrate` with the daemon stopped.

## Run lifecycle

`SessionStore` owns one writable Pi Session and attaches one native
`AgentHarness` with a `main` lane. Existing v4 branches are promoted by Pi without
rewriting conversation history. Once attached, host history writes also go
through that lane so its durable state and transcript have the same owner.
Closing the store closes its harness, Session, repository, and writer lease.

`MikanAgentSession.prompt()` resolves authentication, applies the current prompt
and tool grants, then calls Pi's `lane.accept()` and `lane.drive()`. Pi alone
executes the operation, retries, compacts, and persists results. Budget policy
uses the native `before_request` hook and committed `usage` events. Compaction
usage uses Pi's accounting events; there is no custom completion proxy.

Platform events are translated from native Pi events. Assistant `message_end`
is emitted from `entry_added`, after persistence, rather than Pi's earlier
stream-completion notification. Tool progress retains invocation arguments.
`agent_end` contains only the current operation's messages.

### Cancellation and budgets

`abort()` requests Pi's durable operation cancellation. Before an operation
exists, the adapter remembers cancellation across authentication and setup.
A configured `maxDurationMs` requests cancellation at the deadline, including
provider, tool, retry, and compaction waits. Budgets are checked before native
requests, so exhausted budgets cannot start another paid request.

Cancellation is cooperative: providers and tools must honor their abort signal.
The session stays active until outstanding work and event listeners settle,
including authentication resolvers that do not accept an abort signal. Completed
run duration is fixed when `prompt()` settles. Pi saves the admitted user request
before initial compaction; that request remains in history after cancellation.

### Public integration API

Use `setSystemPrompt(text)` between prompts instead of mutating the removed
`session.agent.state.systemPrompt` property. The underlying low-level `Agent`
is no longer exposed. Per-prompt tool grants use `prompt(text, { tools })`;
subsequent prompts use the session's default tools unless overridden again.

`resume({ budget, tools })` delegates recovery of an open operation to Pi's native
lane. It can be used after reopening a store that contains an accepted or
interrupted operation. A normal new `prompt()` preserves Pi's busy-lane rejection
while an earlier operation is open. The low-level `appendCompaction()` store
helper is limited to unattached stores; live compaction belongs to Pi.

Runner reuse, conversation identity, rotation, eviction, and Sandbox topology
remain in `src/runtime/` and `src/sessions/`.

## Skills

Skills are directories containing `SKILL.md` frontmatter and instructions.
They may come from authorized prompt sources or resolved packages. Package
skills remain external files rather than being inlined, so scripts and
templates beside `SKILL.md` are available through their read-only Sandbox
mount.

mikan deliberately does not load executable plugins from package or state
directories. New host behavior is implemented in the repository and exposed
through explicit platform, runtime, tool, or Sandbox interfaces.

## Subagents

The built-in `subagent` tool and `SubagentRunner` use fresh in-memory sessions,
explicit tool grants, bounded execution, and a non-recursion guard. A request
may contain one task, parallel tasks, or a bounded DAG. Per-run concurrency is
further limited by the process-wide slot pool so busy conversations cannot
multiply the global limit.

Subagent usage is folded into the parent run's usage tally. Validation and run
failures resolve as structured failed results so one bad task cannot orphan its
siblings.

## Boundaries

- The harness receives platform-neutral messages, responders, tools, prompt
  sources, and execution context from `src/agent/` and `src/runtime/`.
- Platform SDK objects and platform credentials do not enter the harness.
- Sandbox filesystem/process operations cross only through the `Executor`
  interface.
- Session file naming, chat synchronization, rotation, and thread lineage stay
  in `src/sessions/`.
