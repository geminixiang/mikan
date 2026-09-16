# mikan Architecture

Architecture diagram: [`docs/architecture.html`](docs/architecture.html) — a single-page HTML/SVG diagram of system ownership, execution flow, and Slack DM task sessions.

This document explains mikan's system-level architecture: the concepts that span modules, the main execution paths, the security and persistence model, and the invariants that must survive implementation changes.

The machine-readable global index is [`architecture.toml`](architecture.toml). Its normative schema and maintenance workflow live in [`.pi/skills/mikan-architecture/`](.pi/skills/mikan-architecture/SKILL.md). Detailed module behavior lives beside its implementation in `src/*/README.md`. Accepted trade-offs live in `docs/adr/`.

## Documentation model

The architecture has four documentation levels, each with one responsibility:

| Authority                 | Answers                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `architecture.toml`       | What modules, seams, resources, flows, invariants, and deviations exist, and how are they connected? |
| Architecture skill/schema | What makes the TOML index conformant, and how is it maintained?                                      |
| `ARCHITECTURE.md`         | How does the system work across modules, and which properties must remain true?                      |
| `src/*/README.md`         | How does one module's interface, lifecycle, failure handling, and implementation work?               |
| `docs/adr/*.md`           | Why was a consequential, difficult-to-reverse design chosen?                                         |

Source and tests are the final evidence that the documented architecture is implemented. `CONTEXT.md` remains the domain glossary; it does not duplicate implementation or architecture specifications.

### Global-index convention

`architecture.toml` is intentionally shallow. The exact fields, enums, typed references, ID grammar, and versioning rules are defined by [the project architecture skill's schema](.pi/skills/mikan-architecture/references/SCHEMA.md):

- IDs are stable references and must not be reassigned to another concept.
- Module and resource records identify ownership, not every source file.
- A seam is a relationship callers depend on, not every TypeScript interface.
- Flow paths show topology, not function-level call traces.
- Invariants and deviations link here for their complete semantics.
- Long explanations, error modes, and algorithms belong in Markdown.

A source-file refactor that preserves ownership and seams normally changes only `sources`. A change to identity, authority, flow topology, trust, or compatibility must update both the index and the relevant explanation here.

## System model

mikan is a multi-platform AI coding agent. Slack, Discord, Telegram, and GitHub adapters translate native events into a common conversation model. A conversation runtime serializes work and owns runner lifecycle. An agent runner constructs the authorized prompt, tools, credentials, and executor, then invokes mikan's harness over `pi-agent-core` and `pi-ai`.

The central unit is the **Conversation office**: one platform conversation's persistent workspace, identity, host state, credentials, sessions, and Sandbox-runtime ownership. The office gives every major subsystem a common scope without exposing raw platform IDs as storage authority.

The architecture is easiest to understand along three axes.

### Identity axis

```text
platform + conversation ID
        │
        ▼
    OfficeAddress ──► OfficeKey ──► Office
        │                 │            │
 platform I/O and      storage      paths, state,
 session-key scope      identity     sessions, vault
```

`OfficeAddress` is canonical conversation identity. `OfficeKey` is the collision-resistant, platform-scoped storage identity. `Office` is the frozen layout value passed to modules that need conversation paths or state.

See [`src/office/README.md`](src/office/README.md) and [ADR 0005](docs/adr/0005-office-address-identity.md).

### Execution axis

```text
platform event
  → conversation intake
  → conversation runtime
  → agent runner
  → harness
  → model and tools
  → platform response
```

The runtime owns queueing and lifecycle. The runner owns one agent run's environment and response. Sessions owns the append-only session tree and its single writer; the harness owns the model/tool loop, retry, compaction, budgets, skills, and bounded subagents.

### Authority axis

mikan separates four kinds of authority:

1. **Conversation data** — office files and sessions visible according to office visibility.
2. **Host-authoritative state** — settings and registry under the State dir.
3. **Credential authority** — vault contents injected only after actor and sandbox resolution.
4. **Host capabilities** — platform clients and repository-defined services that never become ambient sandbox authority.

The Open network is not an authority boundary. A Sandbox runtime may reach the network; access comes from explicit credentials and capabilities.

## Core module map

The complete machine-readable inventory is in `architecture.toml`. The main groups are:

| Group                   | Modules                                               | Detailed documentation                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform edge           | Platform adapters, Conversation intake                | [`src/adapters/README.md`](src/adapters/README.md)                                                                                                                                   |
| Orchestration           | Composition root, Conversation runtime                | [`src/runtime/README.md`](src/runtime/README.md), `src/main.ts`                                                                                                                      |
| Agent core              | Harness and generic agent tools                       | [`src/harness/README.md`](src/harness/README.md)                                                                                                                                     |
| Identity and data       | Office, Sessions, Dream, Configuration                | [`src/office/README.md`](src/office/README.md), [`src/sessions/README.md`](src/sessions/README.md), [`src/dream/README.md`](src/dream/README.md)                                     |
| Execution and authority | Harness execution resolution, Sandbox, Vault          | [`src/harness/README.md`](src/harness/README.md), [`src/sandbox/README.md`](src/sandbox/README.md), [`src/vault/README.md`](src/vault/README.md)                                     |
| External/control edges  | Platform/Web adapters and Commands                    | [`src/adapters/README.md`](src/adapters/README.md), [`src/adapters/web/README.md`](src/adapters/web/README.md), [`src/adapters/commands/README.md`](src/adapters/commands/README.md) |
| Scheduling              | Scheduled-event protocol, office store, and scheduler | [`src/events/README.md`](src/events/README.md)                                                                                                                                       |
| Observability           | OpenTelemetry pipeline and Sentry adapter             | [`src/observability/README.md`](src/observability/README.md), [ADR 0007](docs/adr/0007-standard-otlp-observability.md)                                                               |

## Main flows

### Boot and process lifecycle

`src/main.ts` is the composition root, not the owner of subsystem behavior.

Daemon boot proceeds conceptually as follows:

1. Before loading application modules, initialize the vendor-neutral observability boundary. Sentry issue reporting remains optional; an OpenTelemetry provider is registered only when an explicit OTLP endpoint enables at least one supported signal.
2. Parse argv and select daemon or one-shot CLI mode.
3. Validate deployment settings and the State-dir/workspace relationship.
4. Construct the Workspace and Office registry.
5. Complete crash-resumable legacy office migration before accepting events.
6. Configure sandbox, vault, portal, and platform facilities.
7. Construct the Conversation runtime with capability factories.
8. Start platform bots, web services, the event watcher, and the Dream scheduler.
9. On the first shutdown signal, start one graceful shutdown: begin disconnecting platform intake and closing the Web server, stop new scheduled work, and give accepted adapter work plus the active Dream sweep up to 30 seconds to drain. If they settle, Conversation runtime then closes normally; on timeout, their unresolved promises are no longer allowed to block exit and runtime shutdown starts with no additional run grace, aborts in-flight runner materialization, and awaits cooperative rollback against a five-second deadline measured from runtime shutdown entry. The timed-out shutdown is reported as a failure. Every phase is attempted even when an earlier phase fails.
10. Force-flush and shut down the OpenTelemetry providers, then close Sentry issue reporting, whether graceful application shutdown succeeds or fails. Attempt every configured backend and exit non-zero on any failure or timeout. A second OS signal explicitly abandons the graceful wait and forces a non-zero exit without starting another shutdown.

A migration ambiguity, path conflict, malformed authoritative setting, or unsupported security policy fails startup rather than widening access.

### Conversation run

Every platform feeds the same intake and runtime model:

1. A platform adapter creates an `OfficeAddress`, session key, normalized message/context, and responder capabilities.
2. Conversation intake applies the fixed order: magic word, trigger policy, attachments, platform log, busy policy, queue, dispatch.
3. The runtime serializes events by office and session key.
4. Built-in commands run before runner creation; unmatched slash-prefixed text remains an agent prompt.
5. Session policy resolves history, rotation, thread lineage, and the active session file.
6. Session lifecycle materializes or reuses the runner under a per-session transition, then grants the runtime a lease that prevents invalidation or eviction while it is in use. Conversation runtime materialization normalizes omitted platform trust to `membership`; that trust is fixed for the `OfficeAddress` and is not another cache dimension.
7. Before connecting MCP tools, the runner gates on the fixed trust: `open-trigger` unconditionally uses an empty effective MCP map and skips default provisioning, while `membership` first fills in the deployment's default `open-connector` entry for a Slack office that has not declared one (minting that office's runtime token and saving it as an ordinary conversation `mcpServers` entry), then loads the merged settings map like any other MCP configuration.
8. The sessions-owned `SessionStore` owns MCP connections alongside the session writer. If runner construction fails, the runner closes that owner; it disposes MCP connections before releasing the writer, preserves the original construction failure, and allows the same session to be reconstructed immediately.
9. For each run, the runner resolves one execution decision containing the Workspace projection, concrete executor, and runtime paths; the executor is configured from the same decision's validated mounts and credential grant.
10. The harness runs model and tool turns while persisting session events, enforcing budgets, retrying eligible failures, and compacting context.
11. The runner streams and finalizes the response through platform capabilities.
12. Session lifecycle completes settlement, releases the runner lease, applies deferred invalidation, and only then makes the runner eligible for eviction.

The `stop` magic word is exceptional: it runs before trigger policy and queueing. It is not an ordinary bare command.

### Agent execution

`src/harness/` owns run-level composition, the Pi execution integration, and platform-neutral agent tools. `runner.ts` prepares the authorized tools, execution context, and prompt; `session.ts` integrates Pi's model loop; `tools/` owns generic tool adapters including attach and the agent-facing event tool. Prompt construction, skills, response presentation, and persistent session ownership have explicit implementations within this module. Platform-specific tool packs remain in their adapters and are injected into each runner; the harness does not import a platform adapter implementation. Conversation queueing remains in the runtime, and platform SDK transports remain in adapters.

A runner is conversation-scoped. Mutable platform tool packs are instantiated per runner and bound per serialized run, so platform state cannot leak across conversations. Each run receives one execution decision; its prompt sources, concrete executor, and runtime path context cannot drift because callers do not resolve them independently. The prompt authority constructs a byte-stable system prompt; changing turn facts are added to user-turn instructions to preserve provider cache behavior.

The presenter owns response delivery. The Conversation runtime invokes and settles the runner, but response streaming, replacement, diagnostics, usage display, and file upload are implemented through the runner's `ConversationResponder` interaction.

### Execution resolution

Execution authority is resolved for every agent environment rather than inferred from a filesystem path:

1. Workspace projection resolves the office's visibility into both runtime mounts and authorized prompt sources.
2. The harness-owned execution resolver combines actor identity, office, sandbox configuration, that projection, and vault routing exactly once for the run.
3. Vault resolution returns only the credential environment and files authorized for that actor and execution mode.
4. Sandbox capability checks report when the selected backend cannot enforce a private office's visibility; only `image:*` enforces it, and the other backends are operator-selected trusted modes.
5. The resulting execution decision carries the concrete executor, runtime path context, and projection to the runner; that executor was created from the same final non-overlapping mounts and credential grant.

For every provider call, prompt authorization and filesystem authorization consume the same execution decision. Runner construction uses a bootstrap prompt to initialize the harness, but replaces it from the actor-specific decision before the model can see it. This prevents host-side memory or skills from bypassing an isolated filesystem view.

### Scheduled execution

Scheduled events are host-only per-office state under
`<state-dir>/conversations/<office-key>/events/`. No sandbox layout mounts
them: the agent's `event` tool (`src/harness/tools/event.ts`) and the Admin
HTTP surface are the only writers, and both go through an office-confined
`OfficeEventStore` from `src/events/`. The store never overwrites on create,
answers "not found" for any other office's filename, and notifies the
in-memory `EventScheduler` on every admitted mutation — so deleting a record
cancels its timer or cron before the file is removed. There is no filesystem
watcher; the scheduler loads every registered office's records once at start.
A due record is converted into a normal conversation event, submitted through
the target platform bot, and enters the regular runtime path, sharing session
context, queueing, credentials, tools, stop behavior, and platform settlement
with normal chat.

Cross-office scheduling is not available through the event tool; it requires
the explicit actor-to-target grants defined in `docs/office-policy.md`, which
are not implemented yet. Legacy `<workspace>/events/*.json` records are drained
by `mikan office migrate-events`. Event text must never contain secrets.

### Dream maintenance

Dream is a host-scheduled, per-office maintenance flow, not a chat command or a session-rotation hook. Every ten minutes during Taiwan time 02:00–05:00, the scheduler visits registered offices. The Conversation runtime places each attempt behind the office maintenance barrier, so collection begins only after active session work settles and new work waits until maintenance finishes.

The Dream authority reads every office session file and compares its stable session UUID with the host-private `dream.json` checkpoint. It calls the model only when at least one entry follows a saved `throughEntryId` and the newest settled entry in the office is at least five hours old. Evidence is admitted in bounded batches, with explicitly marked bounded head/tail representations for oversized individual entries and checkpoints advancing only through entries included in the successful batch, so a large backlog drains over later eligible sweeps instead of producing an unbounded prompt. The model runs against an in-memory harness session, combines the batch with the existing Memory anchor, and returns the complete replacement `MEMORY.md`; an absolute 120-second deadline aborts the session and propagates its abort signal to the provider, while the caller rejects generation and prevents a commit even if the provider completes late. Its own prompt and response never become office evidence.

Commit ordering is deliberate: atomically replace `MEMORY.md`, then atomically replace `dream.json`. A generation, model, or memory-write failure leaves the checkpoint unchanged, so evidence is retried rather than silently skipped. `/new` and biweekly rotation only create Clean sessions; neither invokes Dream. Resetting a fixed-path scoped session archives its prior JSONL first, so scheduled Dream can still inspect evidence from before the reset.

The Memory anchor is revisable orientation rather than final truth. Newer conversation evidence outranks it, and mutable external facts require a fresh Live-source or current-API read in the answering run.

## Storage and authority map

```text
<workspace-root>/                         agent data world
├── MEMORY.md                             shared workspace memory
├── skills/                               shared workspace skills
├── agents/                               shared subagent profiles
└── <office-key>/                         one Conversation office
    ├── MEMORY.md
    ├── skills/
    ├── sessions/
    ├── attachments/
    └── log.jsonl

<state-dir>/                              host-private authority
├── settings.json
├── office-registry.json
├── vaults/
└── conversations/<office-key>/
    ├── settings.json
    └── dream.json                        per-session Dream checkpoints
```

The exact paths are owned by the relevant modules, not by this diagram. Code must derive conversation paths from an `Office` value where one is available.

The State dir is never part of a Workspace projection.

## Configuration authority

`src/settings/index.ts` owns settings format, defaults, normalization, validation, and scope merge; `src/settings/apply.ts` is the one write seam for settings that affect live conversations; `src/settings/migrate.ts` holds one-time settings migrations run only from the CLI.

Settings baked into a cached runner—such as model selection or prompt-affecting workspace policy—require cache coordination:

- A conversation mutation clears the affected idle runner before writing, or refuses the write while that conversation is busy.
- A global mutation writes the new default and clears idle conversations; busy conversations are marked stale and refresh before their next turn.
- Settings read at use time may be written without runner invalidation.

This ordering prevents disk settings and the behavior of an apparently current runner from silently disagreeing.

## Security model

### Execution isolation

A managed office-runtime backend gives each Conversation office an independent runtime. Office visibility never changes this runtime separation.

Not every supported execution mode provides this property: host execution and explicitly shared containers are operator-selected trusted modes. Backend capability checks, not backend names alone, decide whether a private office's visibility is enforced; unenforced private offices are served with a logged warning.

### Data isolation

Office visibility (ADR 0008) is derived from the platform conversation type: Slack public channels are public; private channels, DMs, group DMs, externally shared channels, unknown kinds, and every conversation on Telegram, Discord, or GitHub are private. Every office projects the same shape — its own directory read-write, every other public office read-only under `/workspace/public/<key>` (enumerated from the registry on each projection, so a channel changing visibility changes affected containers' mount signature and they rebuild on their next message), and workspace-global `MEMORY.md`/`skills/` read-write for public offices or read-only for private ones. No projection mounts the workspace root. An operator may narrow a public channel to private through Admin or `/pi-sandbox visibility`; nothing widens beyond the platform. Retired door-policy keys are dropped at load time and removed by `mikan office migrate-door-policy`. The policy resolver returns mounts and prompt sources together and rejects malformed authoritative settings.

### Credential authority

Vault selection is independent from runtime resource naming. Open-trigger conversations do not inherit an ambient shared default vault. Credential mounts may not shadow workspace targets. Host execution does not inject conversation vault environment by default.

OpenConnector is an ordinary MCP server with a deployment default. Provider OAuth connections remain shared in the sibling service. When `OPENCONNECTOR_ENDPOINT` is set and neither global nor conversation settings declare `open-connector`, mikan uses its host-only admin authority once to mint a runtime token for the Slack Conversation office, named `mikan:slack:<workspace-id>:<channel-id>`, and saves `{ url, headers }` as a normal entry in that office's host-only conversation settings. The admin token is sent only to the default endpoint's origin and never enters settings, the Vault, or a sandbox; the runtime token lives in settings like every other MCP credential and is not projected into managed sandboxes. A conversation may declare its own self-hosted server or disable the entry, in which case no provisioning happens. Provisioning failure is logged and leaves settings untouched.

The runner applies the same fixed platform trust gate to every settings-declared MCP server: `open-trigger` conversations receive no MCP tools or server instructions, and no configured stdio process is launched. This creation-time gate precedes default provisioning and MCP loading, so the capability cannot enter either the parent or subagent tool sets. `membership` conversations retain MCP loading and default provisioning.

## Cross-module invariants

These IDs correspond to `[[invariants]]` records in `architecture.toml`.

### INV identity office address

<a id="inv-identity-office-address"></a>

**`identity-office-address`** — `OfficeAddress = platform + conversationId` is canonical conversation identity inside mikan. Raw IDs remain at platform I/O, registry mapping, and session-key seams; they are not general storage identity.

Evidence: `src/office/index.ts`, `src/office/types.ts`, ADR 0005.

### INV identity office key

<a id="inv-identity-office-key"></a>

**`identity-office-key`** — Conversation-scoped workspace, State-dir, session, and credential paths use the versioned collision-resistant `OfficeKey`. Its readable segment is only a hint; the digest is authoritative.

Evidence: `src/office/index.ts`, ADR 0005.

### INV office record before directory

<a id="inv-office-record-before-directory"></a>

**`office-record-before-directory`** — Office materialization records the durable address-to-key mapping before creating the office directory. Migration is journaled, idempotent, crash-resumable, and conflict-failing.

Evidence: `src/office/index.ts`.

### INV runtime composite identity

<a id="inv-runtime-composite-identity"></a>

**`runtime-composite-identity`** — Runtime state is identified by `(OfficeAddress, sessionKey)`. A session key follows `conversationId[:suffix]`, is unique only inside its office, and reserves `:` from conversation IDs.

Evidence: `src/runtime/session-lifecycle.ts`, `src/sessions/session-key.ts`.

### INV intake order

<a id="inv-intake-order"></a>

**`intake-order`** — Every platform uses the centralized order `magic word → trigger → attachments → log → busy policy → queue → dispatch`. Platform adapters provide policy data rather than reimplementing this grammar.

Evidence: `src/adapters/intake.ts`.

### INV session serialization

<a id="inv-session-serialization"></a>

**`session-serialization`** — Events sharing an office and session key execute serially. Different session keys may progress independently. Session lifecycle single-flights runner materialization, grants leases for every runner use, and prevents invalidation, disposal, or eviction until those leases and settlements complete.

Evidence: `src/runtime/session-lifecycle.ts`, `src/runtime/conversation-runtime.ts`.

### INV process shutdown order

<a id="inv-process-shutdown-order"></a>

**`process-shutdown-order`** — Graceful shutdown is single-flight. It begins closing external platform/Web intake, stops the event watcher, and gives already-accepted adapter work plus Dream a bounded 30-second drain window. Conversation runtime closes after a successful drain; after a drain timeout, unresolved adapter/Dream promises cannot block exit, runtime aborts stuck work immediately, and the process exits non-zero after bounded cleanup. Every phase is attempted even after an earlier failure. Diagnostics flush last, and a second OS signal forces a non-zero exit without starting another shutdown.

Evidence: `src/main.ts`, `src/cli/process-lifecycle.ts`, `src/adapters/`, `src/adapters/web/server.ts`, `src/events/scheduler.ts`, `src/runtime/conversation-runtime.ts`.

### INV runner materialization rollback

<a id="inv-runner-materialization-rollback"></a>

**`runner-materialization-rollback`** — Runner construction either returns a fully owned runner or settles rollback before rejecting. Shutdown propagates an abort signal through Conversation runtime, OpenConnector provisioning, and MCP connection/tool discovery. Once acquired, MCP connections are disposed before the session writer is closed; cleanup failures are reported without replacing the original construction error, and the same office/session identity can be reconstructed immediately. Session lifecycle awaits cooperative rollback, but reports a non-zero shutdown failure after a fixed five-second materialization grace instead of waiting forever for non-cancellable repository I/O.

Evidence: `src/harness/runner.ts`, `src/harness/mcp.ts`, `src/sessions/session-store.ts`.

### INV run settlement

<a id="inv-run-settlement"></a>

**`run-settlement`** — A run remains active through response delivery, usage, diagnostics, working-state cleanup, and post-run settlement. Session lifecycle owns the settlement record and runner lease; deferred invalidation and eviction run only after both are released.

Evidence: `src/runtime/conversation-runtime.ts`, `src/harness/`.

### INV projection coherence

<a id="inv-projection-coherence"></a>

**`projection-coherence`** — Runtime mounts and host-side prompt sources come from one Workspace-projection decision carried by the run's execution decision. A private office never receives another private office's data, no projection mounts the workspace root, and callers cannot independently recompute prompt visibility after executor resolution.

Evidence: `src/office/projection.ts`.

### INV state dir host only

<a id="inv-state-dir-host-only"></a>

**`state-dir-host-only`** — The State dir is host-private, outside the Workspace root, and never projected into a Sandbox. Important state writes are private and atomic where readers must not observe partial content.

Evidence: `src/settings/index.ts`, `src/file-guards.ts`, `src/office/index.ts`, `src/vault/index.ts`.

### INV Dream commit order

<a id="inv-dream-commit-order"></a>

**`dream-commit-order`** — Dream runs only after office session work settles, processes entries strictly after each session UUID's durable `throughEntryId`, and invokes no model when there is no eligible new evidence. Generation has a 120-second absolute deadline that aborts the session, propagates its abort signal to the provider, and fails the caller closed, including on a late provider completion. A successful update atomically writes the office Memory anchor before atomically advancing the host-private checkpoint. Dream generation uses an in-memory session so maintenance output cannot recursively become new evidence.

Evidence: `src/dream/`, `src/runtime/session-lifecycle.ts`, `src/runtime/conversation-runtime.ts`.

### INV execution policy enforcement

<a id="inv-execution-policy-enforcement"></a>

**`execution-policy-enforcement`** — Only `image:*` enforces office visibility (read-only global knowledge, no reach into other private offices). Host, shared-container, and remote backends are operator-selected trusted modes: a private office there is served with a one-time logged warning per office rather than a wider projection being silently presented as enforced.

Evidence: `src/harness/execution-resolver.ts`, `src/sandbox/index.ts`.

### INV credential least authority

<a id="inv-credential-least-authority"></a>

**`credential-least-authority`** — Credential access derives from actor, office, trigger trust, and sandbox capabilities. Open-trigger conversations receive no ambient shared vault, and credential mounts cannot shadow workspace mounts.

Evidence: `src/harness/execution-resolver.ts`, `src/sandbox/identity.ts`, `src/vault/`.

### INV MCP conversation authority

<a id="inv-mcp-conversation-authority"></a>

**`mcp-conversation-authority`** — A default-provisioned OpenConnector runtime token identifies one Slack Conversation office and is named from the stable Slack workspace and channel IDs; it is minted only when neither settings scope declares `open-connector`. Shared provider OAuth credentials remain in OpenConnector. `OPENCONNECTOR_ENDPOINT` is the deployment default, and its origin is the only destination that may receive the host-only admin token; settings may declare a different server or disable the entry but cannot redirect the admin token. The runtime token is stored as an ordinary conversation `mcpServers` entry in host-only settings and is never projected into a managed Sandbox or the Vault. Failure to provision leaves settings untouched and that runner without OpenConnector. The fixed platform trust gate runs before provisioning and loading: `open-trigger` unconditionally gives the runner an empty MCP map, so configured servers are not launched and MCP tools/instructions cannot enter parent or subagent tool sets. Trust is static for an `OfficeAddress`, is not a runner cache key, and changing it requires runner replacement rather than another cache entry.

Evidence: `src/runtime/conversation-runtime.ts`, `src/harness/runner.ts`, `src/harness/open-connector.ts`, `src/adapters/slack/bot.ts`.

### INV settings runner coherence

<a id="inv-settings-runner-coherence"></a>

**`settings-runner-coherence`** — Runner-baked conversation settings are changed only after lifecycle invalidation succeeds; otherwise the mutation is refused. Global changes mark leased or settling runners for deferred invalidation, which disposes them immediately after their last active lease settles.

Evidence: `src/settings/apply.ts`.

### INV session format compatibility

<a id="inv-session-format-compatibility"></a>

**`session-format-compatibility`** — Harness sessions use the current Pi 0.85 v4 append-only JSONL tree. Persisted headers use `v: 4` and `storageVersion: 1`; mikan metadata is stored as the durable namespaced value `mikan/metadata`. Runtime opening accepts only this current format. New session files become durable before the current pointer changes, and corrupt materialized headers fail instead of silently replacing history. Legacy mikan v3 and Pi 0.84-generation v4 files are converted offline with `mikan sessions migrate` while the daemon is stopped; originals remain as `*.v3.bak` or `*.pi-084.bak`. Thread lineage remains stable across top-level rotation.

Evidence: `src/sessions/session-store.ts`, `src/sessions/store.ts`, `src/sessions/migrate-v3.ts`, `src/sessions/migrate-pi-084.ts`.

## Known deviations

These are explicit current-state limitations, not implicit changes to the accepted architecture.

### DEV Cloudflare Factory floor

<a id="dev-cloudflare-factory-floor"></a>

**`cloudflare-factory-floor` — Open.** Cloudflare is currently exposed as a conversation `SandboxConfig`, while ADR 0002 and ADR 0004 classify remote task sandboxes as ephemeral Factory floors rather than persistent office runtimes. Keep the adapter transitional until task-executor orchestration owns it.

### DEV runtime resource identity

<a id="dev-runtime-resource-identity"></a>

**`runtime-resource-identity` — Open.** Sandbox resource names still derive from raw conversation IDs, while storage and credential authorization use `OfficeKey`. A collision may require runtime recreation but must never grant access to another office's files or credentials. Resource naming should migrate independently.

## Evolution rules

Update `architecture.toml` when any of these changes:

- a top-level module is added, removed, merged, or split;
- ownership of a seam or resource changes;
- a major control path changes topology;
- a cross-module invariant is introduced, weakened, or removed;
- a known deviation is opened or resolved.

Update this file when system-level semantics, trust, ordering, failure behavior, or an invariant's meaning changes. Update a module-local README when the change is contained behind that module's existing seam.

Create an ADR only when a decision is difficult to reverse, surprising without context, and the result of a real trade-off. An ADR explains the decision; it does not replace the current architecture index.

Stable IDs in `architecture.toml` must not be reused for a different concept. Renames should preserve the old ID when the concept is continuous. Removed IDs should remain documented long enough for references to migrate.

The global index should remain shallow. If TOML starts accumulating algorithms, long prose, exhaustive exports, or function-level traces, move that material to this file or the owning module's README.
