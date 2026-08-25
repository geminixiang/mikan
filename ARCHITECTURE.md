# mikan Architecture

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

mikan is a multi-platform AI coding agent. Slack, Discord, Telegram, and GitHub adapters translate native events into a common conversation model. A conversation runtime serializes work and owns runner lifecycle. An agent runner constructs the authorized prompt, tools, credentials, packages, and executor, then invokes mikan's harness over `pi-agent-core` and `pi-ai`.

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

The runtime owns queueing and lifecycle. The runner owns one agent run's environment and response. The harness owns the model/tool loop, append-only session tree, retry, compaction, budgets, skills, and extension hooks.

### Authority axis

mikan separates four kinds of authority:

1. **Conversation data** — office files and sessions visible according to Door policy.
2. **Host-authoritative state** — settings, registry, packages, callback schedules, and extension data under the State dir.
3. **Credential authority** — vault contents injected only after actor and sandbox resolution.
4. **Host capabilities** — platform clients and trusted extension code that never become ambient sandbox authority.

The Open network is not an authority boundary. A Sandbox runtime may reach the network; access comes from explicit credentials and capabilities.

## Core module map

The complete machine-readable inventory is in `architecture.toml`. The main groups are:

| Group                   | Modules                                                                   | Detailed documentation                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform edge           | Platform adapters, Conversation intake                                    | [`src/adapters/README.md`](src/adapters/README.md)                                                                                                                             |
| Orchestration           | Composition root, Conversation runtime, Agent runner                      | [`src/runtime/README.md`](src/runtime/README.md), `src/main.ts`, `src/agent.ts`                                                                                                |
| Agent core              | Harness, Extensions                                                       | [`src/harness/README.md`](src/harness/README.md)                                                                                                                               |
| Identity and data       | Office, Sessions, Configuration, Workspace projection                     | [`src/office/README.md`](src/office/README.md), [`src/sessions/README.md`](src/sessions/README.md), [`src/workspace-projection/README.md`](src/workspace-projection/README.md) |
| Execution and authority | Execution resolver, Sandbox registry and backend plugins, Vault, Packages | [`src/sandbox/README.md`](src/sandbox/README.md), [`src/vault/README.md`](src/vault/README.md), [`src/packages/README.md`](src/packages/README.md)                             |
| Web product             | Harness Web Host, Harness Web Client                                      | [`src/web/harness/README.md`](src/web/harness/README.md), [`packages/web-client/README.md`](packages/web-client/README.md)                                                     |
| Control surfaces        | Commands, capability portals, scheduled-event services                    | [`src/commands/README.md`](src/commands/README.md), [`src/web/README.md`](src/web/README.md)                                                                                   |

## Main flows

### Boot and process lifecycle

`src/main.ts` is the composition root, not the owner of subsystem behavior.

Daemon boot proceeds conceptually as follows:

1. Parse argv and select daemon or one-shot CLI mode.
2. Validate deployment settings and the State-dir/workspace relationship.
3. Construct the Workspace and Office registry.
4. Complete crash-resumable legacy office migration before accepting events.
5. Configure sandbox, vault, package, portal, and platform facilities.
6. Construct the shared Conversation runtime and Harness Web Host.
7. Start platform bots, web transport, the event watcher, and callback scheduler.
8. On shutdown, reject new runs and wait for existing run settlement up to the configured timeout.

A migration ambiguity, path conflict, malformed authoritative setting, or unsupported security policy fails startup rather than widening access.

### Conversation run

Every platform feeds the same intake and runtime model:

1. A platform adapter creates an `OfficeAddress`, session key, normalized message/context, and responder capabilities.
2. Conversation intake applies the fixed order: magic word, trigger policy, attachments, platform log, busy policy, queue, dispatch.
3. The runtime serializes events by office and session key.
4. Built-in commands run before runner creation; built-ins take precedence over extension commands.
5. Session policy resolves history, rotation, thread lineage, and the active session file.
6. The runtime creates or reuses a conversation runner.
7. The runner resolves packages, workspace projection, credentials, executor, model, prompt, skills, extensions, and tools.
8. The harness runs model and tool turns while persisting session events, enforcing budgets, retrying eligible failures, and compacting context.
9. The runner streams and finalizes the response through platform capabilities.
10. Runtime settlement completes usage, working state, lifecycle barriers, and eviction eligibility.

The `stop` magic word is exceptional: it runs before trigger policy and queueing. It is not an ordinary bare command.

### Web Harness run

The website is a complete client of the daemon, not a shell around capability portals:

1. GitHub OAuth resolves an admitted immutable principal and issues an httpOnly browser session.
2. Bootstrap captures an event cursor, enumerates only that principal's `web` Conversation offices, and optionally projects one current Harness session.
3. The browser sends an object-rooted command carrying daemon-issued office, session, and—when cancelling—run identities.
4. The Harness Web Host validates ownership and stale identities, then creates a synthetic Web messaging context.
5. That context re-enters `ConversationRuntime`; queueing, runner creation, SessionStore persistence, settings, sandbox policy, tools, and extensions follow the same path as platform conversations. Slash-prefixed browser text remains literal agent input and cannot dispatch chat-only capability commands.
6. The Web responder translates live output into principal-scoped ordered events. Durable user/assistant messages are still written by the Harness.
7. The browser folds contiguous events into its projection and replaces live text with a fresh durable transcript after settlement.
8. Reconnect replays from epoch/sequence; an expired or foreign cursor forces bootstrap rather than inventing missing state.

New Conversation creates a first-class `platform = "web"` Conversation office. It never aliases a Slack, Discord, Telegram, or GitHub office, and the browser cookie is never exchanged for a Session View token.

### Agent execution

`src/agent.ts` is the run-level orchestration module. It deliberately does not own conversation queueing or the underlying model loop.

A runner is conversation-scoped. Mutable platform tool packs are instantiated per runner and bound per serialized run, so platform state cannot leak across conversations. The runner constructs a byte-stable system prompt; changing turn facts are added to user-turn instructions to preserve provider cache behavior.

The runner also owns response delivery. The Conversation runtime invokes and settles it, but response streaming, replacement, diagnostics, usage display, and file upload are implemented through the runner's `ConversationResponder` interaction.

### Execution resolution

Execution authority is resolved for every agent environment rather than inferred from a filesystem path:

1. Workspace projection resolves the effective Door policy into both runtime mounts and authorized prompt sources.
2. Package resolution supplies trusted extension roots and read-only skill mounts.
3. The execution resolver combines actor identity, office, sandbox configuration, workspace projection, package targets, and vault routing.
4. Vault resolution returns only the credential environment and files authorized for that actor and execution mode.
5. Sandbox capability checks reject policies the selected backend cannot enforce.
6. The concrete executor receives the final non-overlapping mount and credential set.

The sandbox seam is split between the daemon registry and backend packages. `packages/sandbox-contract/` is the single contract authority; each backend declares parsing, capabilities, resolution, provisioning, boot lifecycle, and executor construction through its adapter. The composition root statically registers the built-ins today. Registry identity is open over `{ type: string }`, while the exported `SandboxConfig` union remains the compatibility inventory of built-in configurations. Core resolution must dispatch through the registered adapter rather than switch on a backend name.

Prompt authorization and filesystem authorization originate from the same projection result. This prevents host-side memory or skills from bypassing an isolated filesystem view.

### Scheduled execution

mikan intentionally has two different scheduling authorities.

#### Text events

The workspace `events/` directory is an agent-writable, workspace-wide scheduling bus. A due file is converted into a normal conversation event, submitted through the target platform bot, and enters the regular runtime path. It therefore shares session context, queueing, credentials, tools, stop behavior, and platform settlement with normal chat.

An isolated office does not mount shared events and therefore cannot self-schedule. Trusted layouts may expose the bus. Cross-conversation scheduling is intentional and is not a file-isolation guarantee.

#### Extension callbacks

An extension callback schedule is host-private trusted state. When due, the scheduler calls the Conversation runtime, which serializes the target session, materializes its runner and extensions, then invokes the registered callback directly. No model turn is synthesized.

Text events and callbacks must not collapse into one generic scheduler: they differ in storage trust, invocation path, and execution authority.

## Storage and authority map

```text
<workspace-root>/                         agent data world
├── MEMORY.md                             shared workspace memory
├── skills/                               shared workspace skills
├── events/                               agent-writable scheduling bus
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
├── web-bindings.json                      durable OAuth admission ledger
├── web-harness.key                        Web office ownership HMAC key
├── vaults/
├── extensions/
├── packages/
└── conversations/<office-key>/
    ├── settings.json
    ├── extensions/
    ├── extension-data/
    ├── extension-schedules/
    └── packages/
```

The exact paths are owned by the relevant modules, not by this diagram. Code must derive conversation paths from an `Office` value where one is available.

The State dir is never part of a Workspace projection. Package skill contents may be mounted read-only at a dedicated runtime path, but package extension code executes only on the host.

## Configuration authority

`src/config.ts` owns settings format, defaults, normalization, validation, and legacy migration. `src/settings-mutation.ts` is the one write seam for settings that affect live conversations.

Settings baked into a cached runner—such as model selection or prompt-affecting workspace policy—require cache coordination:

- A conversation mutation clears the affected idle runner before writing, or refuses the write while that conversation is busy.
- A global mutation writes the new default and clears idle conversations; busy conversations are marked stale and refresh before their next turn.
- Settings read at use time may be written without runner invalidation.

This ordering prevents disk settings and the behavior of an apparently current runner from silently disagreeing.

## Security model

### Execution isolation

A managed office-runtime backend gives each Conversation office an independent runtime. Widening a trusted Workspace projection does not weaken this runtime separation.

Not every supported execution mode provides this property: host execution and explicitly shared containers are operator-selected trusted modes. Backend capability checks, not backend names alone, decide which Door policies are enforceable.

### Data isolation

The default `isolated` Door policy produces a conversation-only projection. Trusted policy may opt into shared support files or the full workspace. The policy resolver returns mounts and prompt sources together and rejects malformed authoritative settings.

### Credential authority

Vault selection is independent from runtime resource naming. Open-trigger conversations do not inherit an ambient shared default vault. Credential mounts may not shadow workspace or package targets. Host execution does not inject conversation vault environment by default.

### Portal capability scope

The `/session`, `/admin`, and `/link` surfaces are independent bearer-capability portals. Their server handlers reserve those prefixes before the SPA fallback, and their tokens never enter the Harness Web Client.

A browser session is issued only after an immutable OAuth principal has a completed private-chat admission binding. It authorizes only Web Conversation offices whose keyed owner digest matches that principal; the chat office used for admission is not exposed or inherited. The cookie grants no Admin, vault, or Session View authority, and no host path crosses the browser contract.

### Trusted host code

Extensions run with mikan process authority. They load only from host-controlled directories, including explicitly approved package roots, never from agent-writable workspace directories. Package installation may execute dependency lifecycle scripts and therefore is an administrator trust decision, not a sandbox boundary.

Conversation package loading is offline. Fetch and refresh are explicit Admin operations. Global and conversation package lists are additive, but a conversation-scoped package identity shadows the same global package before any extension import.

## Cross-module invariants

These IDs correspond to `[[invariants]]` records in `architecture.toml`.

### INV identity office address

<a id="inv-identity-office-address"></a>

**`identity-office-address`** — `OfficeAddress = platform + conversationId` is canonical conversation identity inside mikan. Raw IDs remain at platform I/O, registry mapping, and session-key seams; they are not general storage identity.

Evidence: `src/office/address.ts`, `src/office/types.ts`, `src/web/harness/conversation-id.ts`, ADR 0005.

### INV identity office key

<a id="inv-identity-office-key"></a>

**`identity-office-key`** — Conversation-scoped workspace, State-dir, package, session, and credential paths use the versioned collision-resistant `OfficeKey`. Its readable segment is only a hint; the digest is authoritative.

Evidence: `src/office/address.ts`, ADR 0005.

### INV office record before directory

<a id="inv-office-record-before-directory"></a>

**`office-record-before-directory`** — Office materialization records the durable address-to-key mapping before creating the office directory. Migration is journaled, idempotent, crash-resumable, and conflict-failing.

Evidence: `src/office/layout.ts`, `src/office/registry.ts`, `src/office/migration.ts`.

### INV runtime composite identity

<a id="inv-runtime-composite-identity"></a>

**`runtime-composite-identity`** — Runtime state is identified by `(OfficeAddress, sessionKey)`. A session key follows `conversationId[:suffix]`, is unique only inside its office, and reserves `:` from conversation IDs.

Evidence: `src/runtime/session-lifecycle.ts`, `src/sessions/session-key.ts`, `src/web/harness/host.ts`.

### INV intake order

<a id="inv-intake-order"></a>

**`intake-order`** — Every platform uses the centralized order `magic word → trigger → attachments → log → busy policy → queue → dispatch`. Platform adapters provide policy data rather than reimplementing this grammar.

Evidence: `src/adapters/intake.ts`.

### INV session serialization

<a id="inv-session-serialization"></a>

**`session-serialization`** — Events sharing an office and session key execute serially. Different session keys may progress independently. Runner creation, extension callback dispatch, and invalidation respect the same lifecycle barriers.

Evidence: `src/runtime/session-lifecycle.ts`, `src/runtime/conversation-runtime.ts`.

### INV run settlement

<a id="inv-run-settlement"></a>

**`run-settlement`** — A run remains active through response delivery, usage, diagnostics, working-state cleanup, and post-run settlement. Active or unsettled runners cannot be evicted or invalidated.

Evidence: `src/runtime/conversation-runtime.ts`, `src/agent.ts`, `src/web/harness/host.ts`.

### INV projection coherence

<a id="inv-projection-coherence"></a>

**`projection-coherence`** — Runtime mounts and host-side prompt sources come from one Workspace-projection decision. An isolated policy always resolves to conversation-only data.

Evidence: `src/workspace-projection/index.ts`.

### INV state dir host only

<a id="inv-state-dir-host-only"></a>

**`state-dir-host-only`** — The State dir is host-private, outside the Workspace root, and never projected into a Sandbox. Important state writes are private and atomic where readers must not observe partial content.

Evidence: `src/config.ts`, `src/utils/file-guards.ts`, `src/office/registry.ts`, `src/vault/index.ts`.

### INV execution policy enforcement

<a id="inv-execution-policy-enforcement"></a>

**`execution-policy-enforcement`** — A Door policy is accepted only when the selected sandbox backend can enforce its projection. Unsupported isolation fails closed rather than degrading to a wider view.

Evidence: `src/execution-resolver.ts`, `src/sandbox/index.ts`.

### INV credential least authority

<a id="inv-credential-least-authority"></a>

**`credential-least-authority`** — Credential access derives from actor, office, trigger trust, and sandbox capabilities. Open-trigger conversations receive no ambient shared vault, and credential mounts cannot shadow workspace or package mounts.

Evidence: `src/execution-resolver.ts`, `src/sandbox/identity.ts`, `src/vault/`.

### INV portal capability scope

<a id="inv-portal-capability-scope"></a>

**`portal-capability-scope`** — OAuth login must resolve to an existing private-chat admission binding before issuing a browser session. That session authorizes only principal-owned Web Conversations and must never mint, accept, or inherit Session View, Admin, or vault capabilities. Portal prefixes never fall through to the website SPA.

Evidence: `src/web/login/portal.ts`, `src/web/harness/http.ts`, `src/web/server.ts`, ADR 0007.

### INV web conversation ownership

<a id="inv-web-conversation-ownership"></a>

**`web-conversation-ownership`** — A Web office belongs to exactly one immutable OAuth principal through the keyed Web conversation-id grammar. Authorization verifies that grammar against the private deployment key and Office registry. The browser-visible OfficeKey prefix contains only a random nonce, not the stable owner digest. Missing ownership key plus existing Web offices fails startup closed; ownership keys, owner digests, and host paths never enter browser DTOs.

Evidence: `src/web/harness/conversation-id.ts`, `src/office/registry.ts`, ADR 0007.

### INV web run ordering

<a id="inv-web-run-ordering"></a>

**`web-run-ordering`** — Browser mutations carry the selected OfficeKey and full durable Session UUID; cancellation additionally carries the current host-issued run id. Live events are contiguous within one principal epoch and sequence. Duplicate events are ignored, gaps resnapshot, and persisted SessionStore state replaces ephemeral streamed text after settlement.

Evidence: `src/web/harness/host.ts`, `src/web/harness/journal.ts`, `packages/web-client/src/client.ts`, ADR 0007.

### INV settings runner coherence

<a id="inv-settings-runner-coherence"></a>

**`settings-runner-coherence`** — Runner-baked conversation settings are changed only after cache invalidation succeeds; otherwise the mutation is refused. Busy runners affected by global changes refresh before their next turn.

Evidence: `src/settings-mutation.ts`.

### INV extension code trust

<a id="inv-extension-code-trust"></a>

**`extension-code-trust`** — Host-executed extension code originates only from host-controlled state or administrator-approved package roots. Agent-writable Workspace directories are never extension-loader roots.

Evidence: `src/harness/extensions/loader.ts`, `src/packages/`.

### INV schedule authority separation

<a id="inv-schedule-authority-separation"></a>

**`schedule-authority-separation`** — Agent-visible text schedules use the Workspace event bus and re-enter normal runtime; trusted callbacks use host-private state and invoke registered extension code through runtime serialization.

Evidence: `src/events.ts`, `src/extension-schedules.ts`, `src/runtime/conversation-runtime.ts`.

### INV session format compatibility

<a id="inv-session-format-compatibility"></a>

**`session-format-compatibility`** — Harness sessions use a versioned append-only JSONL tree. New session files become durable before the current pointer changes. Corrupt materialized headers fail instead of silently replacing history, and thread lineage remains stable across top-level rotation.

Evidence: `src/harness/session-store.ts`, `src/sessions/store.ts`, `src/sessions/rotation.ts`.

## Known deviations

These are explicit current-state limitations, not implicit changes to the accepted architecture.

### DEV Cloudflare Factory floor

<a id="dev-cloudflare-factory-floor"></a>

**`cloudflare-factory-floor` — Open.** Cloudflare is currently exposed as a conversation `SandboxConfig`, while ADR 0002 and ADR 0004 classify remote task sandboxes as ephemeral Factory floors rather than persistent office runtimes. Keep the adapter transitional until task-executor orchestration owns it.

### DEV Firecracker Workspace projection

<a id="dev-firecracker-workspace-projection"></a>

**`firecracker-workspace-projection` — Open.** Firecracker executes inside a VM but does not implement managed Workspace projection. It therefore cannot satisfy the default isolated-office contract and must be rejected for policies it cannot enforce.

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
