# src/harness

mikan's agent execution module, integrating Pi 0.85's native `AgentHarness` and
`pi-ai` model catalog. Pi owns durable operations, the turn loop, tool execution,
message persistence, retries, compaction, and recovery. mikan supplies prompt
sources, authorized execution and tools, response presentation, per-request budgets,
delegated-spend accounting, and platform-neutral event translation. Platform adapters and Sandbox backends stay outside
this module.

## Files

| File                    | Authority                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner.ts`             | `createRunner` / `PiAgentWrapper`: run construction, authorized execution and tool binding, attachments, resource rollback and disposal         |
| `execution-resolver.ts` | `ActorExecutionResolver`: per-actor executor selection, workspace/vault mount composition, credential injection, and image-container readiness  |
| `execution-env.ts`      | `createSandboxExecutionEnv`: bridges a sandbox `Executor` to pi's `ExecutionEnv` (FileSystem + Shell) for the native read/write/edit/bash tools |
| `session.ts`            | `MikanAgentSession`: native Pi integration, cancellation, budgets, retry/compaction settings and delegated usage accounting                     |
| `prompt.ts`             | Authorized system prompt and per-turn instruction construction                                                                                  |
| `presenter.ts`          | Response streaming/finalization, diagnostics, tool/subagent progress and usage presentation                                                     |
| `models.ts`             | Model catalog and authentication resolution                                                                                                     |
| `jev.ts`                | Adapter over `@geminixiang/jev` for Jev (typesafe/jev), a typed-decision evaluation model; not part of the chat model catalog                   |
| `http.ts`               | Shared HTTP dispatcher configuration                                                                                                            |
| `mcp.ts`                | MCP configuration/presets, transports, discovery/calls, instructions, connection rollback and cleanup                                           |
| `open-connector.ts`     | Default `open-connector` MCP entry: per-conversation runtime-token provisioning and legacy token-file migration                                 |
| `skills.ts`             | Skill parsing/discovery, authorized skill catalog and prompt formatting                                                                         |
| `subagent.ts`           | Bounded isolated subagent execution and the process-wide concurrency slot pool                                                                  |
| `subagent-profiles.ts`  | Subagent profile discovery and validation                                                                                                       |
| `tools/`                | Platform-neutral agent tools, platform tool-pack ports, and the agent-facing scheduled-event adapter                                            |
| `types.ts`              | Shared harness, runner and subagent contracts                                                                                                   |
| `index.ts`              | Harness module exports                                                                                                                          |

## Run lifecycle

`runner.ts` constructs the conversation-scoped `PiAgentWrapper` and uses
`execution-resolver.ts` to bind each actor's authorized executor, runtime paths,
workspace projection, Vault credentials, and managed image-container readiness
to that run's tools and prompt. The resolver rejects overlapping mount targets
before executor creation and reports provisioning failures without changing
cleanup ownership. `prompt.ts` owns prompt construction; `presenter.ts` turns
session events into responder operations. These responsibilities share the
harness module with the native Pi session integration rather than forming a
separate agent-runner module.

The session-owned `SessionStore` in `src/sessions/` supplies the writable Pi
Session and native `AgentHarness` lane consumed here. The harness drives that
lane but does not own its persistence, writer lease, or lifecycle.

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

File and shell behavior comes from pi-agent-core's native tools. mikan's thin
adapter preserves their schemas, adds the presentation `label`, and supplies
an authorized sandbox `ExecutionEnv`. Native execution tools require
`toolContext.env`; there is no implicit host fallback. Existing integrations
using only plain `AgentTool`s may omit `toolContext`.

`resume({ budget, tools })` delegates recovery of an open operation to Pi's native
lane. It can be used after reopening a store that contains an accepted or
interrupted operation. A normal new `prompt()` preserves Pi's busy-lane rejection
while an earlier operation is open. Compaction belongs to Pi; `SessionStore`
does not expose a second structural compaction writer.

Runner reuse, conversation identity, eviction, and Sandbox topology
remain in `src/runtime/` and `src/sessions/`.

## Host MCP capabilities

MCP belongs to the harness, not a separate integration module. `mcp.ts` connects
stdio or streamable-HTTP servers, namespaces tools as `mcp__<server>__<tool>`,
and preserves server instructions. The session-owned
`SessionStore.connectMcp()` acquires these capabilities under the session writer's
lifetime and returns only the tools; the agent runner does not retain a separate
cleanup handle. The native harness
system-prompt supplier composes the stored MCP guidance with each refreshed
base prompt, so later turns cannot discard server instructions.

Per-server connection/discovery failures close that client's transport and
leave other servers usable. Aborted runner construction closes acquired MCP
connections before releasing its writer. Admin verification can use
`loadMcpTools()` directly and must dispose its short-lived validation result.

`mcp.ts` also owns standard `mcpServers` JSON parsing, safe server names,
credential redaction and reviewed presets. Installation materializes a preset
into the existing global/conversation settings map; there is no second catalog
of installed state. Settings credentials remain host-private.

`open-connector.ts` treats OpenConnector as an ordinary MCP server with a
deployment default. When `OPENCONNECTOR_ENDPOINT` is set and neither global nor
conversation settings declare `open-connector`, the host mints one runtime token
for the Slack office with the host-only `OPENCONNECTOR_ADMIN_TOKEN` (sent only to
the endpoint's origin) and saves `{ url, headers.Authorization }` as a normal
conversation `mcpServers` entry. Creation is single-flight per office and a
failure leaves settings untouched and is logged. From then on the entry is
loaded, tested, disabled, removed, or replaced by a self-hosted declaration
exactly like any other server; removing it re-provisions on the next runner.
The loader passes tool arguments through unchanged — connection selection is
the server's own concern. `mikan office migrate-openconnector` converts legacy
`open-connector-runtime-token.json` files into such entries.

The agent's creation-time trust gate still precedes provisioning and loading:
`open-trigger` gets no MCP servers, tools or guidance; `membership` keeps the
configured capabilities. Subagents receive only the parent-authorized tool
set, including MCP tools granted by their profiles, and do not own or reconnect
parent MCP clients. MCP connection setup/cleanup is not performed per turn.

## Skills

Skills are directories containing `SKILL.md` frontmatter and instructions.
They come from the authorized workspace or conversation prompt sources, so
scripts and templates beside `SKILL.md` remain available to the agent.

mikan deliberately does not load executable plugins from state directories. New host behavior is implemented in the repository and exposed
through explicit platform, runtime, tool, or Sandbox interfaces.

## Subagents

The built-in `subagent` tool delegates to `subagent.ts`, using fresh in-memory sessions,
explicit tool grants, bounded execution, and a non-recursion guard. A request
may contain one task, parallel tasks, or a bounded DAG. Per-run concurrency is
further limited by the process-wide slot pool so busy conversations cannot
multiply the global limit.

Subagent usage is folded into the parent run's usage tally. Validation and run
failures resolve as structured failed results so one bad task cannot orphan its
siblings.

## Jev

`jev.ts` is a thin adapter over [`@geminixiang/jev`](https://github.com/geminixiang/jev)
for Jev (`typesafe/jev`), a typed-decision model that scores a shared `state`
against typed questions instead of generating text. It has no place in
`models.ts`'s catalog: `Provider`/`Model`/`stream()` are chat/completion
shaped, and Jev's boolean-probability/choice/score answers do not fit that
contract; `@geminixiang/jev` is a pi-ai-shaped SDK for a different, typed-decision
API, so it does not go through pi-ai's provider machinery either. `evaluateWithJev`
is a plain function callers use directly — classification, routing, or guardrail
call sites each own their own questions and interpret the returned
probabilities; there is no shared call site or `/model`-style selection for
it. mikan pins the `openrouter` backend (the same `OPENROUTER_API_KEY` pi-ai's
`openrouter` chat provider reads; see `env-manifest.ts`) and adapts
`@geminixiang/jev`'s request/answer shapes to the caller-facing contract this
file has always exposed, so a future backend or dependency change stays
isolated to this one file. A missing key or unresolvable auth surfaces as
`JevNotConfiguredError` before making a request.

Jev is reached four ways — harness-internal decision points (Slack auto-reply
`addressed`, DM task intent), the `jev` tool (`tools/jev.ts`, a direct
pass-through the model composes state/questions for itself), and
`jev_browser`'s (`tools/jev-browser.ts`) per-step decision loop — all through
this one `evaluateWithJev`. Harness-internal call sites never show the model
the result and fail closed to the pre-Jev rule when the key is missing; the
two tools surface a missing key as a tool error the model sees, since it must
then judge or act for itself. `evaluateWithJev` requires a `caller` option
naming which of the four call sites is asking, and reports every call's
token usage, cost, and duration to `recordJevOutcome`
(`../observability/index.js`, tagged `agent.jev.*`) regardless of outcome —
Jev spend is otherwise invisible in Sentry/OTel next to the primary chat
model's per-run cost, and instrumenting inside this one function covers all
four call sites instead of each one remembering to report it. The report
never carries the judged state, questions, or answers.

`jev_browser` runs **every** `agent-browser` command (including cleanup) through
this runner's actor-resolved sandbox `Executor`, not a host subprocess. The CLI,
Chrome, named browser sessions, and output files belong to that sandbox; the
same session name can be used from the sandbox's `bash` tool. Jev's decision
requests still use the host-side adapter above. Tool assembly is not restricted
to host mode; each backend must provision `agent-browser` and its browser
runtime on the sandbox PATH. A missing CLI is a provisioning error: the tool
does not install packages, use a global npm fallback, or launch a browser on
the mikan host. Explicit host sandbox mode uses its configured host Executor.
Session names inherit the runtime's isolation: explicitly shared host/container
runtimes must use distinct names where separate browsers are desired.

## Boundaries

- The harness receives platform-neutral messages, responders, tools, prompt
  sources, and execution context from `src/runtime/` and injected host capabilities.
- Platform SDK objects and platform credentials do not enter the harness.
- Sandbox filesystem/process operations cross only through the `Executor`
  interface; Sandbox owns container provisioning while the harness resolver
  supplies the authorized execution plan and readiness callback.
- Scheduled-event payload schema, parsing and building belong to `src/events/index.ts`.
- Session file naming, chat synchronization, and thread lineage stay
  in `src/sessions/`.

## DM task handoff

`start_task` is offered only when the active responder supports task admission.
It is excluded from subagent grants and unsupported turns. The native
`before_tool` hook blocks every call in a mixed handoff/effect batch; a successful
single handoff terminates the parent turn. Slack owns anchor creation and scoped
queue admission; the task uses the existing independent session runner, not a
nested subagent or a new execution loop.

`PiAgentWrapper.steer` accepts text controls from the current actor only. It
records a `mikan.control_input` custom entry before sending to the native lane so
chat-history sync cannot replay cancelled or rejected controls as ordinary input.
Attachments require stopping and starting another turn. Native steering acceptance
means queued for the next tool-batch boundary, not proof of model compliance.

`task_status` is a responder-bound read-only query, advertised only when supported
and excluded from subagent grants. It exposes no cross-office task lookup.
`SessionStore.inspectExecution` reads the main lane/result from a temporary v4
snapshot; it does not create a runner or acquire the original file's writer.

Runner cancellation is remembered across prompt preparation. Stop before Pi starts
prevents a later prompt; preparation/settlement controls are rejected with a retry
message instead of creating queued work. Final renderer replacements propagate
transport failure, unlike best-effort incremental updates, so failed result updates
do not trigger task completion mentions.
