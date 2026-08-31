# src/harness

mikan's model-facing agent harness, built directly on `pi-agent-core` and
`pi-ai`. It owns model selection, session-tree persistence, the turn loop,
budgets, retries, compaction, skills, and bounded subagents. Platform adapters
and Sandbox backends stay outside this module.

## Files

| File                   | Authority                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `runner.ts`            | `MikanAgentSession`: prompt/run lifecycle, tool execution, retries, compaction, budgets, usage, abort, and disposal |
| `session-store.ts`     | pi v4 JSONL session-tree loading and persistence                                                                    |
| `models.ts`            | model catalog and authentication resolution                                                                         |
| `settings.ts`          | harness retry, compaction, and budget settings                                                                      |
| `skills.ts`            | `SKILL.md` parsing, discovery, diagnostics, and prompt formatting                                                   |
| `subagent-profiles.ts` | subagent profile discovery and validation                                                                           |
| `subagent-runner.ts`   | bounded isolated subagent execution                                                                                 |
| `subagent-slots.ts`    | process-wide subagent concurrency slots                                                                             |
| `usage.ts`             | usage aggregation and cost accounting                                                                               |
| `event-format.ts`      | event-file payload schema shared by the event tool and watcher                                                      |
| `http.ts`              | shared HTTP dispatcher configuration                                                                                |
| `types.ts`             | exported harness and subagent types                                                                                 |
| `index.ts`             | harness module exports                                                                                              |

## Run lifecycle

`MikanAgentSession` owns one writable session-store handle. A run:

1. reloads the current session branch;
2. builds the system prompt and visible skills;
3. invokes the model through `pi-agent-core`;
4. executes allowed tools;
5. persists model, tool, compaction, and usage entries;
6. applies retry, budget, and abort policy; and
7. emits harness events consumed by the presentation layer.

Runner ownership and reuse belong to `src/runtime/session-lifecycle.ts`; the
harness does not decide conversation identity, session rotation, eviction, or
Sandbox topology.

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
