# src/harness

mikan's agent execution module, integrating the pi-durable `Harness` and the
`pi-ai` model catalog (ADR 0017). Pi owns durable runs, the turn loop, tool execution,
message persistence, retries, compaction, and recovery. mikan supplies prompt
sources, authorized execution and tools, response presentation, per-request budgets,
delegated-spend accounting, and platform-neutral event translation. Platform adapters and Sandbox backends stay outside
this module.

## Run lifecycle

`runner.ts` constructs the conversation-scoped `PiAgentWrapper` and uses
`execution-resolver.ts` to bind each actor's authorized executor, runtime paths,
workspace projection, Vault credentials, and managed image-container readiness
to that run's tools and prompt. The resolver rejects overlapping mount targets
before executor creation and reports provisioning failures without changing
cleanup ownership. `prompt.ts` owns prompt construction; `presenter.ts` turns
session events into responder operations in two passes: a run observer records
telemetry, run accounting, and daemon logs from the raw Pi event, then
`run-events.ts` translates the event into a platform-neutral `RunEvent` that the
front projection renders through the responder. The front projection reads only
`RunEvent`s, so another view of the same run (such as Session View) can consume
the same stream without re-deriving state from chat-shaped responder calls.
The front projection keeps one view of the run's main message: the tool
checklist (or subagent dashboard), then the current answer text or a notice
such as compaction, and hands the whole view to `replaceResponse` on every
change. Text written before a tool call stays under the checklist until the
next answer text replaces it. Thinking goes only to diagnostics. The final
answer is written once, by `finalizeRunResponse` with `{ final: true }`; the
front projection never writes it, because two writers of the final message
disagreed about attribution and progress and rewrote it up to three times.

Mechanical conventions belong to mikan, not the model. The presenter reacts
`saluting_face` (eyes on GitHub) once when a run starts its first work tool, and
`appendTriggerAttribution` owns the chat signature, replacing whatever
`Triggered by` line the model wrote from habit. The model is asked to sign only
GitHub text it writes itself (mostly through `gh`), which mikan cannot see. Each
user message already carries its send time, so the prompt no longer sends the
model to `date`. Before this, 97% of final answers repeated the signature, the
signature instruction prefixed every user message, and each acknowledgement cost
a separate model round before any work began.

The system prompt names the folders already in the office's `scratch/` and asks
the model to reuse a clone before making another. A thread or `/new` session
starts without earlier tool output, so it otherwise could not tell a repository
was already there: in production, one office held 23 clones of the same
repository. The listing reads one directory level through
`pinDirectoryNoFollow`, because the agent owns `scratch/` and could replace it
with a link to a host path. It shows at most the 30 most recently changed
folders and skips names with control characters, which would otherwise inject
lines into the prompt.
These responsibilities share the
harness module with the native Pi session integration rather than forming a
separate agent-runner module.

The session-owned `SessionStore` in `src/sessions/` supplies the Harness and
root conversation consumed here. The harness binds models, settings, and the
execution environment to it but does not own its persistence, writer lease, or
lifecycle.

`MikanAgentSession.prompt()` resolves authentication, installs the run's tools,
prompt section, and hooks as the `mikan` extension, configures the conversation's
model and offered tools, then submits the input and waits for it to settle. Pi
alone executes the run, retries, compacts, and persists results. A run that a
previous process left unfinished is aborted before a new prompt, never resumed
implicitly; `resume()` continues it explicitly. Interrupted tool calls are not
rerun unless the tool is `replay: "safe"`.

`HarnessEvent` is a thin, one-to-one projection of pi-durable's agent events,
which are derived from commits: assistant `message_end` arrives after
persistence, and tool progress carries the latest `details`. It adds only what
Pi has no event for: budget stops, nested codemode tool calls, and retry bounds.
`text_delta` is the one derived event: Pi batches every change within a commit,
so an answer's first text arrives inside `message_start` or a block start, and
its last text may arrive only with `message_end`. The session tracks the
in-flight answer's text and emits what each event added, so the deltas of an
answer add up to its committed text. It does not emit run and turn boundaries; a run ends when `prompt()` settles. Pi writes an aborted assistant entry only when a
partial was committed, and the model context omits errored and aborted answers,
so read a run's answer from `lastRunMessages` and its outcome from
`getLastRunStats().status`. The session keeps no transcript copy: read the model
context and context size from `SessionStore` (`buildSessionContext`,
`getContextTokens`). Context size follows Pi's rule: the usage of the newest
successful answer after the latest compaction, unknown until one exists.

Pi supplies each conversation's provider `sessionId`; mikan does not replace it
with the platform-facing session ID. mikan still wraps the model catalog for
budgets and to know whether a request is in flight when it logs an abort,
because pi-durable does not expose provider transport admission. The abort log
marks a request from its `onPayload` call, not
from `pi.live.generation`: a generation exists while credentials resolve and
before the transport starts, so it cannot tell whether a provider ever received
the request, and an abort during auth, a tool, or retry backoff must not be
reported as an aborted LLM request.

### Cancellation and budgets

`abort()` requests Pi's durable operation cancellation. Before an operation
exists, the adapter remembers cancellation across authentication and setup.
A configured `maxDurationMs` requests cancellation at the deadline, including
provider, tool, retry, and compaction waits. Budgets are checked before every
provider request, including compaction summaries; a request over the LLM-call
budget is answered locally as aborted instead of being sent. Usage comes from
the conversation's `pi.usage` document, so compaction spend counts too.

Cancellation is cooperative: providers and tools must honor their abort signal.
The session stays active until outstanding work and event listeners settle,
including authentication resolvers that do not accept an abort signal. Completed
run duration is fixed when `prompt()` settles. Pi saves the admitted user request
before initial compaction; that request remains in history after cancellation.

### Tool loop guard

`loop-guard.ts` watches each run's tool calls through pi-durable's public
`beforeTool` and `afterTool` hooks. A call's identity is its tool name plus canonical JSON
arguments without the presentation `label`. The same call made 3–4 times in a
row gets a notice appended to its result, the 5th through 9th are blocked
without executing, and the 10th stops the run through the budget circuit breaker
(`budget_exceeded` with a `tool loop:` reason). A repeating cycle of 2–6
distinct calls only gets a notice, once at 3 repetitions and again each time
the count doubles. Subagents get the same guard because they run on
`MikanAgentSession`. State resets on every `prompt()` and `resume()`.

### Compaction

Pi compacts in the background as context approaches its threshold, blocks the
next request only above `contextWindow - reserveTokens`, and compacts once
after a context-overflow error. mikan no longer starts a separate idle
compaction between runs.

### Public integration API

Use `setSystemPrompt(text)` between prompts instead of mutating the removed
`session.agent.state.systemPrompt` property. The underlying low-level `Agent`
is no longer exposed. Per-prompt tool grants use `prompt(text, { tools })`;
subsequent prompts use the session's default tools unless overridden again.

File and shell behavior comes from `@earendil-works/pi-durable/tools`. mikan's
thin adapter preserves their schemas, adds the presentation `label`, and the
Harness supplies the run's authorized sandbox `ExecutionEnv` as `api.env`.
Execution tools fail without one; there is no implicit host fallback.
Host mode uses Pi's `NodeExecutionEnv`. Container sandboxes use
`execution-env.ts`, which runs each file operation as a `docker exec`, so it
keeps every round trip to one: `openBinaryReader` checks the file and returns
its bytes in a single command, then reads, scans lines, and reports metadata
from that snapshot, and `openDirReader` pages one `listDir`. It does not offer
`watch` (`not_supported`), which no mikan tool uses. Its `exec` reports stdout
and stderr as separate chunks, in that order, rather than interleaved.
Integrations using only plain `AgentTool`s may omit `toolContext`; `pi-tools.ts`
adapts them, forwarding progress `details` and awaiting the last update before
the result.

`resume({ budget, tools })` lets Pi continue a run left unfinished in the store.
Compaction belongs to Pi; `SessionStore` writes compaction entries only when
`mikan migrate` imports older sessions.

Runner reuse, conversation identity, eviction, and Sandbox topology
remain in `src/runtime/` and `src/sessions/`.

## Host MCP capabilities

MCP belongs to the harness, not a separate integration module. `mcp.ts` connects
stdio or streamable-HTTP servers, namespaces tools as `mcp__<server>__<tool>`,
and keeps each server's description and instructions. The session-owned
`SessionStore.connectMcp()` acquires these capabilities under the session writer's
lifetime and returns only the tools; the agent runner does not retain a separate
cleanup handle. Each request carries Pi's `mcp_servers` prompt section, one line
per server (`renderMcpServersSection`), in its own section so the base prompt
stays cached; scripts read full instructions with `describeNamespace()`.

MCP tools are harness-native tools, so each call receives the turn's execution
env. They connect at construction as before and are never declared by default
(`codemode` exposure): codemode discovers and calls any currently granted MCP
tool. A server with `exposure: "deferred"` also gets `tool_search`, which
declares matches for the next model call. Loaded names follow the session branch and are intersected with current
grants on every run; direct platform/execution tools remain declared. See
[tools/README.md](tools/README.md#mcp-exposure-and-deferred-discovery) for discovery and recovery
contracts. `mcp-result.ts` converts a result's content blocks (`structuredContent`
only when `content` is empty; binary resources and audio become one-line
descriptions), re-serializes JSON text compactly, and bounds the text by Pi's
`DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`, the same limits as `read` and `bash`.
Oversized JSON becomes a structural digest that keeps every key, array counts
and scalar pagination fields while shortening long strings, arrays and deep
nesting; other text keeps its head. The full result is spilled, as indented JSON
so `read` and `grep` work line by line, through the execution env to `<runtime cwd>/.mikan/mcp-output/` (image mode: the
container's `/workspace/.mikan`, outside the office mount), and the notice names
that path. Error results are bounded the same way. MCP tools are wrapped with
`withSecretRedaction`, which scrubs only mikan's own manifest secrets.

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
the server's own concern.

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
Chrome, the runner's browser, and output files belong to that sandbox. Jev's decision
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
records a `mikan.control_input` custom entry before its checks and before
submitting a steer, so chat-history sync never replays a message that took the
control path, whether accepted, cancelled, or rejected. Attachments require
stopping and starting another turn. Native steering acceptance means queued for
the next tool-batch boundary, not proof of model compliance.

The marker deliberately precedes the checks; do not move it after them:

- A cancelled steer must not return: syncing the log after a stop withdrew a
  queued steer put it back into the next context as an instruction
  (`docs/research/conversation-task-handoff.md`, experiment C9; guarded by
  `slack-task.test.ts`).
- A rejected steer is not lost silently. Every rejection is posted back telling
  the user to send again or stop first, so syncing the original as well would
  show the model the same instruction twice.
- The current-actor check is defensive. Only Slack one-to-one DMs (`im`) reach
  steering, so a different person cannot steer someone else's task there.

`task_status` is a responder-bound read-only query, advertised only when supported
and excluded from subagent grants. It exposes no cross-office task lookup.
`SessionStore.inspectExecution` reads the live run and mikan's run record from a
copy of the storage; it does not create a runner or acquire the original writer.

Runner cancellation is remembered across prompt preparation. Stop before Pi starts
prevents a later prompt; preparation/settlement controls are rejected with a retry
message instead of creating queued work. Final renderer replacements propagate
transport failure, unlike best-effort incremental updates, so failed result updates
do not trigger task completion mentions.
