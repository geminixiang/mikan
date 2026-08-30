# mikan agent-loop audit trace architecture

- **Status:** accepted architecture research; Phase 1 durable metadata audit is implemented in the accompanying change
- **Date:** 2026-08-29
- **Scope:** mikan runtime/agent/harness/session/Admin path, OpenAI Codex rollout trace, pi instrumentation seams, and a durable SQLite-backed audit subsystem

## Executive decision

Implementation note: the production change accompanying this research implements a run-centered, durable metadata-only Phase 1: indexed run filters plus a pageable per-run event timeline. Cross-run event search and Codex-like raw diagnostic capture remain explicitly out of scope.

mikan should **not merge the current working-tree quick patch as the production audit implementation**. It is useful as a seam and Admin UX spike, but its raw-by-default capture, per-session synchronous SQLite behavior, failure propagation, missing coverage, and absent privacy/retention controls are unsuitable for a long-running daemon.

The next architecture should have two explicitly different products:

1. **Durable normalized audit — default**
   - Deployment-owned, SQLite-indexed, privacy-minimized, retention-governed.
   - Queryable by office/conversation, run ID, tool name, status, and time range.
   - Captures typed run/turn/model-attempt/tool lifecycle metadata, final aggregates, and policy-shaped evidence.
   - Does not persist token deltas or repeated streaming snapshots.

2. **Raw diagnostic capture — opt-in**
   - Short-lived, high-sensitivity evidence for debugging exact provider/tool behavior.
   - Separate policy and storage namespace, explicit enablement, short TTL, restricted reveal/download, and access logging.
   - May borrow Codex rollout trace's raw-evidence principles, but is not the durable audit database.

The durable subsystem should be a single deployment-owned `AgentAuditStore` with a bounded, non-throwing ingestion queue, one serialized background writer, versioned immutable event envelopes, normalized query tables/projections, explicit health/degraded state, and a metadata-first Admin UI.

## Terminology and non-goals

| Term               | Meaning                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Audit event        | A durable, typed statement that an operational action occurred, with stable identity and policy-shaped evidence. |
| Projection         | Query-oriented state derived from immutable audit events, rebuildable using a named projector version.           |
| Diagnostic capture | Optional high-fidelity raw evidence intended for temporary debugging, not routine product history.               |
| Session transcript | Conversation state used to continue an agent session. It is not an audit trail.                                  |
| Platform chat log  | Platform messages synchronized for conversation history. It is not an agent-loop audit trail.                    |
| Telemetry          | Passive spans/metrics for latency, cost, and errors. It is not durable audit authority.                          |

This decision does **not** make platform delivery receipts part of the agent-loop audit. Delivery can later become a correlated product event, but its boundary must be documented separately. It also does not require exact prompts, chain-of-thought, full tool outputs, or wire payloads to be retained by default.

## 1. Current mikan data and control paths

### 1.1 Runtime admission is the correct run-identity boundary

`ConversationRuntime` derives a `sessionKey` from a platform event, serializes work for the `(OfficeAddress, sessionKey)` scope, obtains or creates the runner, synchronizes platform history, marks the session running, wraps `runner.run()` in Sentry spans/metrics, and then settles the run. This is the earliest seam that covers setup and terminal failure while already knowing the durable office/conversation identity. See [`src/runtime/conversation-runtime.ts:472-729`](../../src/runtime/conversation-runtime.ts) and the composite queue/runner identity in [`src/runtime/session-lifecycle.ts:17-29,57-70,202-275`](../../src/runtime/session-lifecycle.ts).

**Decision:** allocate the product `runId` at runtime admission, not inside `MikanAgentSession.prompt()`. Pass an immutable audit context down through runner and harness. Use the same `runId` for Sentry correlation and Admin lookup.

This makes failures in history synchronization, runner setup, payload preparation, and harness execution part of one run. The quick patch creates its UUID only inside the harness, after setup, so those earlier failures are invisible.

### 1.2 Runner prepares the actual run but is not the sole audit authority

`createRunner()` resolves the office/session file, loads tools, MCP, and extensions; `prepareRunContext()` reconstructs the system prompt, skills, execution context, and user input; the runner calls `session.prompt()` and then finalizes platform response and usage. See [`src/agent/runner.ts:80-230,300-425,432-580`](../../src/agent/runner.ts).

The runner should enrich the runtime-created audit context with session/model/config facts, but should not own the database. It also must not invent a second run identity.

### 1.3 `MikanAgentSession` is the current canonical normalized loop seam

mikan's working harness constructs pi's low-level `Agent` with `streamFn`, `beforeToolCall`, and `afterToolCall`, subscribes to `AgentEvent`, persists final messages, and produces mikan-specific retry, compaction, and budget events. See [`src/harness/runner.ts:120-174,317-500,578-680`](../../src/harness/runner.ts).

This is the correct primary source for normalized loop events:

- run/turn lifecycle;
- final assistant messages and provider usage;
- tool start/update/end;
- retry, compaction, budget, and recovery signals supplied by mikan.

It is not sufficient alone for runtime setup failures, subagent parentage, or each concrete provider retry/fallback attempt.

### 1.4 Session JSONL and platform logs remain separate authorities

The session store is a pi v4 JSONL transcript/tree facade. It saves final message, custom, and compaction entries, but not the complete run lifecycle, streaming deltas, or every provider attempt. See [`src/harness/session-store.ts:1-13,327-415,500-590`](../../src/harness/session-store.ts).

The platform `log.jsonl` is chat history used for bootstrap/synchronization, not agent evidence. See [`src/sessions/chat-history-sync.ts:107-159,213-240,667-690`](../../src/sessions/chat-history-sync.ts).

**Decision:** do not overload either store with audit queries. Audit rows may reference session entry IDs where useful, but the authorities remain distinct.

### 1.5 Subagents require explicit child-run correlation

Subagents create another `MikanAgentSession` and currently use an in-memory `SessionStore`. The quick patch does not inject its audit logger there, so subagent execution is absent. See [`src/harness/subagent-runner.ts:588-650,746-760`](../../src/harness/subagent-runner.ts).

Each subagent should receive a new child `runId` plus:

- `parentRunId`;
- `parentToolCallId` when spawned by a tool;
- `runKind = subagent`;
- its own model-attempt and tool-call identities.

### 1.6 Existing Admin authentication is too broad for raw evidence

Admin uses a short-lived in-memory bearer token and permits office selection through the current scope helpers. See [`src/web/admin/portal.ts:21-39,92-160,283-350`](../../src/web/admin/portal.ts). This is adequate to prototype metadata queries, but it is not a raw-evidence authorization model: there is no role separation, explicit reveal permission, or audit of access to sensitive content.

## 2. OpenAI Codex rollout trace: what it actually is

Primary-source snapshot: OpenAI Codex commit [`6478a751fde8884b2fdc76486fe23175a8e795d4`](https://github.com/openai/codex/tree/6478a751fde8884b2fdc76486fe23175a8e795d4).

### 2.1 Product boundary: opt-in local diagnostic evidence

Codex describes rollout trace as an opt-in, local-only diagnostic artifact. A bundle can contain prompts, responses, tool I/O, terminal output, and paths. It is written only when `CODEX_ROLLOUT_TRACE_ROOT` is set, and Codex does not upload it. [Codex rollout-trace README, lines 1-16](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/README.md#L1-L16).

That is categorically different from a daemon subsystem expected to remain enabled and queryable for months. Codex's design may inform diagnostic capture, but its default privacy, operational, and query requirements are not mikan's.

### 2.2 Bundle and reducer model

A rollout trace bundle contains:

- `manifest.json` with trace/rollout/root-thread identities;
- append-only `trace.jsonl` as the raw event spine;
- `payloads/*.json` for heavyweight evidence;
- optional reducer output `state.json`.

The raw log follows “observe first, interpret later.” Its reducer reconstructs threads, turns, conversation items, inference calls, tool calls, code cells, terminals, compactions, interaction edges, and raw references. [README, lines 24-125](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/README.md#L24-L125); [bundle constants and manifest](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/bundle.rs#L8-L47).

The raw envelope has schema version, writer sequence, wall-clock time, rollout ID, optional thread/turn IDs, and a typed payload. Large content is referenced through `RawPayloadRef`. [Raw event schema](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/raw_event.rs#L21-L232); [payload kinds](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/payload.rs#L1-L52).

### 2.3 Writer behavior

A single mutex serializes child-thread writes and assigns both payload ordinals and event sequence numbers. The writer creates the complete payload file before appending the referencing event, flushes after each JSONL event, and does not maintain reduced state. It tolerates a poisoned mutex so tracing failure does not panic the session. [Writer implementation](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/writer.rs#L26-L145).

This gives mikan useful principles—central ordering authority, payload-before-reference ordering, and failure isolation—but not adequate daemon durability or throughput. Per-event flush is not a SQLite transaction model, and the bundle has no cross-run index, retention GC, Admin authorization, or health state.

### 2.4 Integration and canonical seams

Codex uses typed contexts that become no-ops when tracing is disabled rather than scattering optional writer checks. Root setup is enabled only by environment configuration; child threads share the root writer; resumed children can disable duplicate start events. Startup and write failures warn and continue. Lazy closures avoid cloning large tool arguments when capture is disabled. [Thread context](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/thread.rs#L44-L149), [write methods](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/thread.rs#L303-L379), and [session root/child wiring](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/session/session.rs#L974-L1028).

Its model seam records each concrete transport attempt after constructing the request, gives attempts separate IDs, propagates an inference-call header, and uses an exactly-once terminal guard for completed/failed/cancelled outcomes. It stores completed response items rather than high-volume token deltas. [Turn integration](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/session/turn.rs#L2212-L2249), [attempt model](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/inference.rs#L20-L285), and [HTTP wiring](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/client.rs#L1630-L1702).

Tool instrumentation is at the canonical registry dispatch boundary, before lookup/hooks/handler, and pairs early failures as well as successful post-hook results. It distinguishes request source and separates original invocation, immediate requester-facing result, and runtime/protocol observations. [Tool registry](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/tools/registry.rs#L523-L634), [terminal paths](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/tools/registry.rs#L722-L770), [adapter](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/src/tools/tool_dispatch_trace.rs#L1-L126).

### 2.5 Reducer semantics

The deterministic offline reducer reads the event log and referenced payloads. It distinguishes what the model actually saw from runtime evidence and uses pending queues to tolerate concurrency and temporal inversion. It does not force the producer to fabricate semantic ordering that was not observed. [Reducer entry/state](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/reducer/mod.rs#L43-L146), [reduced graph](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/model/mod.rs#L20-L120), and [runtime versus conversation evidence](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/rollout-trace/src/model/runtime.rs#L101-L158).

The reducer is exposed through a hidden local debug command, not a supported end-user workflow. [CLI declaration and dispatch](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/cli/src/main.rs#L244-L257), [command implementation](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/cli/src/main.rs#L2181-L2192).

One implementation caveat should be preserved in our assessment: the README states raw sequence/corruption and payload-reference invariants, while the examined reducer loop parses in file order and opens payloads as semantic processing reaches them; it does not visibly perform a separate exhaustive contiguous-sequence/schema/payload existence validation. Do not treat a documented invariant as automatically equivalent to complete validation.

### 2.6 What mikan should and should not borrow

Borrow:

- typed, no-op-capable capture contexts;
- canonical run/model-attempt/tool seams;
- distinct attempt, run, thread/subagent, and tool-call identities;
- immutable raw facts separated from derived projections;
- exactly-once terminal guards;
- completed items/aggregates rather than token deltas;
- producer records observed facts; projector resolves concurrency.

Do not borrow for durable audit:

- one filesystem bundle per root session;
- raw sensitive evidence as the central storage shape;
- silent best-effort failure without health/degraded state;
- whole-bundle offline reduction for routine Admin queries;
- no retention, access-control, or cross-run index.

## 3. pi-agent-core, pi-ai, and pi-telemetry seams

Primary-source snapshot for the installed mikan dependencies: pi commit [`bfb004d4418ff05c6f909eaaab856cbe75c1fde0`](https://github.com/earendil-works/pi/tree/bfb004d4418ff05c6f909eaaab856cbe75c1fde0), published as `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-telemetry` 0.84.3.

### 3.1 `Agent.subscribe()` is the normalized primary seam

`AgentEvent` includes agent, turn, message, and tool-execution lifecycle events. Tool events carry call ID, tool name, arguments, result, and error status; `message_update` also contains the underlying provider-neutral `AssistantMessageEvent`. [Agent event union](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/types.ts#L421-L443).

`Agent.subscribe()` listeners are awaited in registration order, and even `agent_end` listener completion is part of run settlement. [Agent subscription implementation and contract](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent.ts#L240-L253), [event processing](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent.ts#L538-L590).

**Consequence:** the audit listener must perform only bounded synchronous shaping/enqueue and must never throw. Awaiting a SQLite insert, JSON serialization of unrestricted payloads, or backlog flush in this listener directly adds latency or failure to the agent run.

### 3.2 Do not persist every streaming update

The agent loop converts provider `text_*`, `thinking_*`, and `toolcall_*` updates into `message_update`. Each event contains both the delta and the full partial message as of that point. [Provider stream reduction](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent-loop.ts#L317-L358).

Persisting each update verbatim repeats an ever-growing snapshot and creates approximately quadratic content growth for long outputs. The durable reducer should ignore streaming updates or retain only bounded timing/count aggregates. Raw diagnostic mode may retain deltas with strict byte/run limits, never repeated full snapshots.

### 3.3 Tool argument semantics require care

`tool_execution_start` is emitted before tool lookup, argument preparation, schema validation, and `beforeToolCall`. Its `args` are the model-produced raw arguments. [Sequential and parallel start events](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent-loop.ts#L433-L505), [prepare and validation](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent-loop.ts#L600-L660).

`tool_execution_end` is emitted after execution and any `afterToolCall` override. [Finalization and end event](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/agent-loop.ts#L713-L774).

Therefore:

- label start-event arguments as `requestedArgs`, not `executedArgs`;
- use `toolCallId` to join lifecycle rows;
- if exact validated executed arguments become a requirement, capture them through a failure-contained composition of `beforeToolCall` or a canonical tool dispatcher wrapper;
- do not add instrumentation independently to every tool implementation.

Parallel tool end events follow completion order, while transcript tool-result messages preserve assistant source order. Correlation must use `toolCallId`, not adjacency. [pi agent README](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/README.md#L111-L124).

### 3.4 Final assistant messages already expose most durable model facts

The standard `AssistantMessage` contains provider/API/model, optional concrete response model and provider response ID, usage/cost, normalized and raw stop reason, error, timestamp, and redacted diagnostic records. [Assistant message type](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/src/types.ts#L427-L446). The stream protocol distinguishes start, text/thinking/tool-call content events, and terminal done/error events.

For routine audit, final `message_end` is enough for completion metadata, usage, response ID, stop reason, and error. A transparent `streamFn` wrapper is needed only for request-level timing or per-attempt facts that are not represented in the final message.

### 3.5 `onPayload` is a dangerous diagnostic seam, not audit truth

pi's `onPayload` callback receives the fully assembled provider payload and may replace it by returning a value. `onResponse` receives HTTP status and headers. [Hook contracts](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/src/types.ts#L118-L149).

OpenAI Responses awaits `onPayload` after body construction and awaits `onResponse` after receiving the HTTP response. [OpenAI Responses implementation](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/src/api/openai-responses.ts#L130-L166). Codex likewise invokes `onPayload`, but its WebSocket route does not invoke `onResponse`; only the SSE/HTTP route does, and retries may invoke it multiple times. [Codex request and WebSocket route](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/src/api/openai-codex-responses.ts#L256-L320), [SSE response/retry route](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/src/api/openai-codex-responses.ts#L377-L423).

The header helper copies all headers without an allowlist. [Header conversion](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/ai/src/utils/headers.ts#L1-L18).

**Decision:**

- never use `onPayload`/`onResponse` as the canonical durable model audit;
- only use `onPayload` in raw diagnostic mode, with an observer that always returns `undefined`, is exception-contained, and applies redaction/limits before enqueue;
- do not persist arbitrary response headers; use a small explicit allowlist if a diagnostic need is established;
- model attempt identity and timing should be owned by a provider-neutral stream wrapper or future pi attempt hook, not inferred from `onResponse`.

### 3.6 pi telemetry complements but cannot replace audit

pi telemetry defines a vendor-neutral explicit context with no exporter or ambient global state. Its contract requires recording to be synchronous, passive, and non-throwing. The in-memory reference is process-local, unbounded, and records no timestamps. [Telemetry overview and contract](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/telemetry/README.md#L1-L13), [adapter contract](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/telemetry/README.md#L116-L130), [in-memory limitations](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/telemetry/README.md#L154-L176).

The official security guidance calls telemetry process-local diagnostics and advises against prompts, completions, tool arguments/output, file contents, provider payloads, headers, credentials, and free-form errors unless an explicit schema and policy allow them. [Telemetry integration and security](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/telemetry/README.md#L365-L391).

The pi AI schema contains request metadata, response ID/status, usage/cost, chunk count, time to first chunk, and error type—not content. [AI schema](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/telemetry.ts#L42-L118). Its tool span similarly records identifiers and error outcome, not arguments/results. [Tool span schema](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/telemetry.ts#L399-L450).

Use telemetry for latency/cost/error dashboards and correlate it with `runId`; use SQLite audit as the durable query authority.

Finally, the new upstream `AgentHarness` in 0.84.3 is still a scaffold: `prompt`, hooks/events/watch, and related operations return `HarnessNotImplemented`; its `context?: TelemetryContext` option is declared but not used by the constructor. [AgentHarness scaffold](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/agent-harness.ts#L243-L262), [unimplemented operations](https://github.com/earendil-works/pi/blob/bfb004d4418ff05c6f909eaaab856cbe75c1fde0/packages/agent/src/harness/agent-harness.ts#L347-L441). mikan cannot assume upstream harness telemetry is automatically emitted today.

## 4. Assessment of the working-tree quick patch

### 4.1 What the patch demonstrates successfully

The patch:

- creates a deployment-wide `<state-dir>/audit.sqlite` path;
- records prompt start/end and normalized harness events;
- extracts conversation/run/tool/time query columns from JSON payloads;
- adds an Admin endpoint and timeline-like raw JSON view.

The spike was uncommitted and has now been discarded. Its touched surfaces were `src/agent/catalog.ts`, `src/harness/runner.ts`, the removed `src/harness/audit-log.ts`, and `src/web/admin/portal.ts`; the discussion below preserves the review findings rather than treating the spike as current source.

The useful learnings are:

- `MikanAgentSession` event reduction is the right normalized loop seam;
- deployment state is the right broad location for cross-office queries;
- query-critical columns should be separate from evidence JSON;
- conversation/run/tool/time is a valid first Admin UX.

### 4.2 Production blockers

#### Failure containment

`record()` serializes before safely entering its promise chain. `JSON.stringify` can throw because of getters, `toJSON`, unsupported depth/size, or memory pressure. The first record occurs before the prompt `try/finally`; a failure can leave `runActive` true. The terminal record occurs before state restoration in `finally`; failure can skip cleanup. See the reviewed spike's `src/harness/runner.ts` changes and removed `src/harness/audit-log.ts` implementation.

Audit must never alter business outcome or cleanup. The hot path must accept already bounded typed values into a non-throwing queue. Serialization and database errors belong to the writer's degraded-state path.

#### Volume amplification

The patch stores every `message_update` with its complete partial snapshot, every tool update, and `agent_end.messages`. This creates repeated content, can include images/base64, terminal output, paths, tool details, and model reasoning, and has no byte limit, classification, redaction, or TTL.

#### Daemon writer shape

Each event opens `DatabaseSync`, runs DDL, inserts, and closes. Each session has a private promise tail rather than a deployment-wide ordering/writer authority. Synchronous SQLite work runs on Node's event loop, and the run awaits `flush()`. There is no bounded queue, batching transaction, WAL policy, busy timeout, health counter, or shutdown owner. This behavior lived in the spike's removed `src/harness/audit-log.ts`.

#### Query shape

Queries also synchronously open the database, execute DDL, fetch and parse complete payloads, and use offsetless fixed limits. Admin sends raw JSON and truncates only in the browser. This behavior lived in the spike's removed `src/harness/audit-log.ts` and temporary Admin portal additions. Payload selection and truncation must occur server-side, with keyset pagination and summary projections.

#### Privacy and local permissions

The patch has no explicit private create mode for the SQLite database and companion WAL/SHM files. Under a typical `022` umask, a newly created database can be group/world readable. Existing mikan state-directory validation is not equivalent to confidential-file permissions, whereas session state already uses explicit private-file behavior. See [`src/main.ts:106-143`](../../src/main.ts) and [`src/harness/session-store.ts:401-428`](../../src/harness/session-store.ts).

#### Identity and coverage

The patch lacks office key, event sequence, schema/projector version, turn/model-attempt IDs, status/duration, subagent parentage, and runtime setup failures. Its harness-created run ID is unavailable to runtime/Sentry. It also does not instrument subagents and cannot distinguish exact provider attempts.

#### Schema operations and tests

There is no migration/version authority, retention/GC, checkpoint/vacuum plan, payload hash/size, corruption/recovery policy, or composite query index. The added test covers one happy-path query but not failure isolation, filters, large streams, tools, abort/retry, subagents, retention, permissions, or Admin authorization.

**Disposition:** keep the patch as research evidence or extract tests/UX lessons later; do not merge it as the production subsystem, and do not document it in `ARCHITECTURE.md` as an established durable resource.

## 5. Proposed architecture

### 5.1 Resource authority and lifecycle

Create one deployment-owned `AgentAuditStore` service during boot and inject narrow interfaces into runtime, harness, and Admin:

```text
boot
└─ AgentAuditStore
   ├─ AuditRecorder       non-throwing producer API
   ├─ AuditWriter         one serialized background writer/connection
   ├─ AuditReader         bounded indexed queries
   ├─ RetentionWorker     scheduled chunk deletion/checkpoint/maintenance
   └─ AuditHealth         queue depth, drops, failures, degraded status
```

The service owns database open/migration, writer connection, queue, scheduled retention, and shutdown drain/checkpoint. Individual sessions must not open their own database connections.

Because Node's `DatabaseSync` API is synchronous, all database work should be isolated from agent event callbacks. A dedicated worker thread is preferable for predictable event-loop latency; a single scheduled background drain is an acceptable first implementation only if batches are bounded and measurements show it does not stall the daemon. Node documents `DatabaseSync` as synchronous. [Node `node:sqlite` documentation](https://nodejs.org/api/sqlite.html#class-databasesync).

### 5.2 Identity model

Keep identities distinct:

| Identity                     | Authority                 | Purpose                                                     |
| ---------------------------- | ------------------------- | ----------------------------------------------------------- |
| `officeKey`                  | Office registry/workspace | Durable deployment-local conversation-office identity.      |
| `platform`, `conversationId` | Platform boundary         | UI display/filter; raw platform ID is not a path authority. |
| `sessionKey`, `sessionId`    | Runtime/session           | Thread/session continuation identity.                       |
| `runId`                      | Runtime admission         | One admitted top-level or subagent run.                     |
| `parentRunId`                | Runtime/subagent          | Run hierarchy.                                              |
| `turnId`                     | Harness                   | One assistant response plus tool batch.                     |
| `modelAttemptId`             | Model seam                | One concrete provider transport attempt/retry/fallback.     |
| `toolCallId`                 | Model/harness             | Tool lifecycle correlation.                                 |
| `eventId`, `runSequence`     | Audit recorder/store      | Idempotency and stable ordering within a run.               |

Use UUIDv7 or another time-sortable opaque ID where mikan already has an approved helper. Do not conflate artifact/trace identity with run identity.

### 5.3 Capture seams

#### Runtime

Emit:

- `run_admitted`;
- `run_setup_failed`;
- `run_started` after runner readiness;
- `run_completed`, `run_aborted`, or `run_failed`;
- stable duration/outcome and Sentry correlation.

#### Agent subscription reducer

Reduce `AgentEvent` to:

- `turn_started`, `turn_completed`;
- final `model_completion` facts from assistant `message_end`;
- `tool_requested`, `tool_completed`;
- selected mikan retry/compaction/budget/recovery events.

Ignore routine `message_update` content. Maintain bounded in-memory counters for chunk count and time-to-first-content if useful.

#### Model stream wrapper

A transparent wrapper around the provider-neutral `streamFn` can capture logical request time, selected model/provider/API, and final result without wire payloads. If pi later exposes a stable per-transport-attempt hook, use it for exact retry/fallback attempts. Until then, distinguish clearly between **logical model request** and **concrete provider attempt**; do not claim attempt fidelity that the seam cannot observe.

Compaction and branch-summary model requests must use the same wrapper if they are within audit scope.

#### Tool dispatcher/control hooks

Use start/end `toolCallId` correlation for standard audit. If validated arguments or execution duration must be known, instrument the common pre-execution/post-execution boundary, composing existing hooks rather than replacing them. Capture all early failures and post-hook final outcomes.

#### Subagents

Create a child audit context at subagent admission and pass it to the child session. Preserve parent run/tool correlation without sharing mutable sequence state incorrectly.

### 5.4 Non-throwing ingestion

The producer API should accept a closed typed envelope and return immediately:

```ts
interface AuditRecorder {
  record(event: AuditEvent): void; // total, bounded, non-throwing
}
```

Required properties:

- no unrestricted `JSON.stringify` on the agent callback path;
- no database access or promises returned to the agent loop;
- immutable/copy-owned bounded values;
- per-field shaping and truncation before enqueue;
- bounded queue measured in both events and bytes;
- priority classes: lifecycle/metadata before optional content;
- explicit overflow policy and counters;
- writer failure changes audit health, never the agent result.

Suggested overflow policy:

1. discard raw diagnostic chunks first;
2. discard optional content blobs next, retaining metadata and hashes/sizes;
3. preserve run terminal events through a small reserved capacity;
4. if even metadata cannot enqueue, increment a non-audit in-memory/telemetry drop counter and mark the store degraded.

Unlike Codex diagnostic tracing, durable audit loss must be visible in Admin and telemetry. “Non-blocking” must not mean “silently trustworthy.”

### 5.5 SQLite schema

Use immutable event evidence plus online projections. A representative schema—not final DDL—is:

```sql
CREATE TABLE audit_event (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  office_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_key TEXT,
  session_id TEXT,
  run_id TEXT NOT NULL,
  run_sequence INTEGER NOT NULL,
  parent_run_id TEXT,
  turn_id TEXT,
  model_attempt_id TEXT,
  tool_call_id TEXT,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  status TEXT,
  payload_class TEXT NOT NULL,
  payload_json TEXT,
  payload_bytes INTEGER NOT NULL,
  payload_sha256 TEXT,
  redaction_version INTEGER NOT NULL,
  expires_at_ms INTEGER,
  UNIQUE(run_id, run_sequence)
);

CREATE TABLE audit_run (... summary and terminal facts ...);
CREATE TABLE audit_tool_call (... requested/completed projection ...);
CREATE TABLE audit_model_attempt (... request/completion projection ...);
CREATE TABLE audit_projection_state (
  projector_name TEXT PRIMARY KEY,
  projector_version INTEGER NOT NULL,
  last_event_rowid INTEGER NOT NULL
);
```

Recommended indexes based on requested queries:

```sql
CREATE INDEX audit_event_office_time
  ON audit_event(office_key, occurred_at_ms DESC, event_id DESC);
CREATE INDEX audit_event_run_seq
  ON audit_event(run_id, run_sequence);
CREATE INDEX audit_event_office_tool_time
  ON audit_event(office_key, tool_name, occurred_at_ms DESC, event_id DESC)
  WHERE tool_name IS NOT NULL;
CREATE INDEX audit_event_expiry
  ON audit_event(expires_at_ms)
  WHERE expires_at_ms IS NOT NULL;
```

The projection tables should be updated in the same transaction as their source events. Store projector versions so projections can be rebuilt without mutating raw facts. Admin normally queries projections and fetches selected evidence by `eventId`; it does not run an offline whole-database reducer.

### 5.6 SQLite operational policy

Use a single writer connection and short batch transactions. SQLite permits multiple readers but only one simultaneous writer; explicit transactions make the boundary clear. [SQLite transactions](https://sqlite.org/lang_transaction.html).

Recommended boot policy:

- verify/create a private parent directory;
- open one writer connection;
- run migrations under an exclusive startup lock;
- set and check `PRAGMA user_version` as the schema migration version ([SQLite `user_version`](https://sqlite.org/pragma.html#pragma_user_version));
- use WAL mode for read/write concurrency, understanding that WAL adds `-wal` and `-shm` companion files and requires same-host shared memory ([SQLite WAL](https://sqlite.org/wal.html));
- configure a finite busy timeout rather than immediate `SQLITE_BUSY` failure ([SQLite `busy_timeout`](https://sqlite.org/pragma.html#pragma_busy_timeout));
- use prepared statements and bounded transaction batches;
- expose queue/write/checkpoint failures through `AuditHealth`;
- close/drain on daemon shutdown with a deadline; never make platform reply settlement wait for routine drain.

Retention deletion does not automatically shrink the database file. Run chunked deletion regularly, checkpoint WAL under controlled load, use `PRAGMA optimize` as SQLite recommends for planner statistics ([SQLite `optimize`](https://sqlite.org/pragma.html#pragma_optimize)), and schedule `VACUUM` only when file reclamation is necessary and operational headroom exists because it rebuilds the database ([SQLite VACUUM](https://sqlite.org/lang_vacuum.html)).

Backups must either use SQLite's supported backup mechanism or a coordinated checkpoint/copy procedure; copying only the main database while WAL is live is not a valid complete snapshot.

### 5.7 Privacy and evidence classes

Classify before storage:

| Class              | Examples                                                                           |  Default retention | Admin default              |
| ------------------ | ---------------------------------------------------------------------------------- | -----------------: | -------------------------- |
| `metadata`         | IDs, event type, model/tool name, status, duration, token/cost totals, byte counts |            longest | visible                    |
| `redacted_summary` | bounded error message, content preview after redaction                             |             medium | visible with truncation    |
| `content`          | prompt/final text, shaped tool args/result                                         |  short or disabled | explicit reveal            |
| `raw_diagnostic`   | exact provider payload, full tool/terminal evidence, headers if allowlisted        | very short, opt-in | privileged reveal/download |

Default durable audit should store metadata plus narrowly defined redacted summaries. For content that is not retained, store useful non-reversible facts such as byte count, content type, and keyed/non-keyed hash only where the threat model permits correlation.

Never persist by default:

- credentials, authorization/cookie headers, vault values;
- image base64 or file bodies;
- chain-of-thought/thinking content;
- full environment variables;
- unrestricted terminal output;
- arbitrary tool `details` objects;
- complete provider request/response payloads.

Redaction should be schema-aware and versioned, not a single regex applied after JSON serialization. Every stored payload records `redactionVersion`, class, original/stored byte counts, and truncation flags. Unknown tool schemas should fall back to metadata-only, not raw storage.

The OWASP logging guidance likewise says logs should exclude or mask session identifiers, access tokens, authentication passwords, connection strings, encryption keys, payment/bank data, and other sensitive personal data, and recommends testing logging failures and preventing logging from stopping the application. [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude), [verification guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#verification).

### 5.8 Filesystem security

Place audit storage in a deployment-private directory, not merely a generally readable state directory. Enforce private permissions for:

- the directory;
- main database;
- WAL and SHM files;
- diagnostic blob directories/files;
- exports/download staging.

Create the private directory with owner-only access before opening SQLite, verify ownership/type/no symlink traversal using existing mikan state-dir safety patterns, and re-check companion file modes after WAL initialization. Encryption at rest is an operational deployment concern unless an approved SQLite encryption implementation is selected; do not claim application-level encryption merely because the disk may be encrypted.

### 5.9 Retention

Retention is policy by evidence class, not one database-wide age:

- metadata: e.g. 90 days by default, configurable;
- redacted summaries: e.g. 30 days;
- optional content: e.g. 7 days;
- raw diagnostic: e.g. 24 hours, hard maximum unless explicitly extended;
- legal/incident holds: future feature requiring explicit governance, not an implicit infinite TTL.

The exact defaults require product approval. The architecture requires:

- `expiresAt` decided at ingestion;
- periodic small delete batches ordered by expiry;
- deletion of external blobs before/with reference removal using a retryable tombstone state;
- metrics for oldest expired row and retained bytes;
- an Admin-visible retention configuration and last-GC result;
- deletion by office/conversation/run for incident response and privacy requests;
- projection rows deleted consistently with evidence.

### 5.10 Query API and Admin UI

Use stable keyset pagination rather than offset pagination:

```text
GET /admin/api/audit/runs?
  officeKey=...&from=...&to=...&status=...&cursor=...

GET /admin/api/audit/events?
  officeKey=...&runId=...&toolName=...&eventType=...&cursor=...

GET /admin/api/audit/runs/:runId
GET /admin/api/audit/events/:eventId/evidence
```

The cursor should encode `(occurredAtMs, eventId)` or `(runSequence, eventId)`. Apply strict server-side maximum page size, selected columns, statement deadlines where possible, and byte limits. Never load/parse large payload JSON for a list query.

Admin screens:

1. **Audit health:** enabled mode, queue bytes/depth, dropped counts by class, last write/migration/GC/checkpoint error, database size, oldest/newest event.
2. **Run list:** office/conversation, run kind/status, start/duration, model, tools, usage/cost, content-availability badges.
3. **Run timeline:** normalized lifecycle and correlated child runs/model attempts/tool calls; concurrency displayed honestly rather than forced into adjacency.
4. **Tool/model detail:** metadata, durations, status/errors, sizes/hashes/redaction outcome.
5. **Evidence reveal:** explicit action, server-side authorization and redaction, access event, response byte cap, no automatic browser embedding of binary/base64.

Until mikan has roles, raw evidence should remain disabled in Admin or require a distinct capability/token from ordinary Admin metadata access. Reading raw evidence must itself create a metadata-only access audit entry without recursively capturing its response body.

## 6. Event model

A first version should use closed event types:

```text
run_admitted
run_started
run_setup_failed
run_completed | run_aborted | run_failed
turn_started | turn_completed
model_request_started | model_request_completed | model_request_failed | model_request_aborted
model_retry_scheduled
model_completion_observed
tool_requested | tool_started | tool_completed | tool_failed | tool_blocked
compaction_started | compaction_completed | compaction_failed
budget_threshold | budget_exhausted
subagent_spawned | subagent_completed
content_dropped | audit_degraded | audit_recovered
```

Do not persist a giant arbitrary `agent_event` union as the long-term public schema. The online reducer maps dependency-specific events into mikan-owned versioned audit events. Preserve the source event name/version as metadata for diagnosis, but keep query semantics stable when pi evolves.

For each terminal operation, record exactly one terminal event using an in-memory guard keyed by operation identity. The database's unique constraints provide final idempotency protection.

Time semantics:

- `occurredAtMs`: producer wall clock;
- optional monotonic duration measured within process;
- `ingestedAtMs`: writer time;
- `runSequence`: producer-assigned causal observation order within the run;
- no assertion that sequence is a total semantic order across concurrent tool executions.

## 7. Delivery plan

### Phase 0 — remove architectural ambiguity

- Keep the working-tree quick patch unmerged or clearly marked as a spike.
- Document the two product modes and default privacy posture.
- Confirm retention defaults and whether raw diagnostic mode is required in the first release.

### Phase 1 — durable metadata audit

- Add deployment-owned store lifecycle and private storage directory.
- Allocate `runId` at runtime admission and propagate audit context.
- Add typed reducer for runtime and final Agent events.
- Implement bounded non-throwing ingestion, background batch writer, schema migrations, health, and shutdown.
- Store metadata only; no prompt/tool content.
- Add indexed Admin run/event queries and health screen.

Success criteria:

- injected serialization/SQLite/disk-busy failures never change agent result or leave session state wedged;
- no synchronous database call occurs in `Agent.subscribe()`;
- large streaming responses produce bounded event/byte volume;
- runtime, normal tool run, failure, abort, retry, compaction, and subagent paths are correlated;
- conversation/run/tool/time queries use intended indexes and keyset pagination;
- private permissions include WAL/SHM.

### Phase 2 — projections and richer attempt/tool correlation

- Add run/tool/model-attempt projection tables and rebuild tooling.
- Add transparent model wrapper and canonical validated tool boundary where needed.
- Include compaction and subagent model calls.
- Add usage/cost/duration summaries and Sentry correlation.

### Phase 3 — optional content and diagnostic capture

- Add schema-aware redaction/classification and evidence TTLs.
- Introduce explicit diagnostic enablement per deployment/run/conversation.
- Add privileged reveal/download plus access auditing.
- Enforce run/byte/time caps and automatic expiry.

Do not start Phase 3 by wiring `onPayload` into permanent SQLite JSON rows.

## 8. Verification matrix for implementation

| Area              | Required tests                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failure isolation | throwing getters/`toJSON`, serialization failure, DB closed/corrupt/busy/read-only, disk full simulation, writer worker crash; agent outcome and cleanup unchanged |
| Backpressure      | queue event/byte cap, priority drops, reserved terminal capacity, health/degraded/recovered transitions                                                            |
| Ordering          | parallel tools complete out of order; correlation by IDs; unique run sequence; idempotent replay                                                                   |
| Volume            | long streaming text/thinking/tool-argument streams stay O(final size) or metadata-only, not O(n²)                                                                  |
| Lifecycle         | setup failure, blocked tool, missing tool, validation failure, tool throw, abort, retry, overflow recovery, compaction, subagent                                   |
| Privacy           | credentials/headers/base64/paths/tool secrets absent by default; redaction and truncation versions recorded                                                        |
| Retention         | per-class expiry, chunk deletion, external blob tombstones, projection cleanup, restart safety                                                                     |
| SQLite            | migration upgrade/rollback policy, WAL/busy behavior, crash mid-batch, checkpoint, backup/restore, permissions for DB/WAL/SHM                                      |
| Query             | composite filters, keyset stability, index plans, server-side byte/page limits, malformed cursor/input                                                             |
| Admin             | metadata authorization, raw capability separation, reveal access event, no raw content in list/API errors                                                          |
| Shutdown          | bounded drain deadline, restart after undrained queue, no reply latency dependency                                                                                 |

## 9. Final comparison

| Dimension      | Codex rollout trace                       | mikan durable audit                              | mikan raw diagnostic                       |
| -------------- | ----------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| Enablement     | Explicit environment opt-in               | Expected product subsystem; policy-configurable  | Explicit opt-in                            |
| Purpose        | Developer replay/debug evidence           | Long-term operational accountability/query       | Short-term exact debugging                 |
| Storage        | Per-rollout bundle: JSONL + payload files | Deployment SQLite + optional controlled blobs    | Separate short-TTL namespace               |
| Content        | High-fidelity, highly sensitive           | Minimized normalized metadata/summaries          | Potentially high-fidelity, redacted/capped |
| Reduction      | Offline whole-bundle reducer              | Online incremental versioned projections         | Optional offline/targeted reducer          |
| Query          | Local files/debug CLI                     | Indexed Admin API by office/run/tool/time/status | Privileged by trace/run                    |
| Retention      | User-managed local files                  | Explicit class-based GC                          | Hard short TTL                             |
| Failure model  | Best-effort warning/continue              | Non-intrusive but health-visible/degraded        | Best-effort, prominently visible           |
| Access control | Local filesystem                          | Admin metadata capability                        | Separate reveal/download capability        |

**One-sentence decision:** Codex rollout trace is a user-enabled, high-sensitivity, session-local replay bundle for debugging; mikan's agent audit must instead be a daemon-owned, privacy-minimized, retention-governed, health-visible, SQLite-indexed product subsystem, with any Codex-like raw capture offered only as a separate short-lived diagnostic mode.
