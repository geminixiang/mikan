# Context

## Domain terms

- **Conversation intake**: The platform-message entry flow that decides whether an incoming chat message should start an agent run. It includes magic-word recognition, trigger/auto-reply policy, attachment preparation, conversation log writing, busy policy, queue selection, and dispatch to the runtime handler.
- **Magic word**: A highest-priority chat control phrase that bypasses normal trigger policy and queueing rules, such as `stop`. Conversation intake owns the single magic-word grammar for every platform; platform adapters state only policy data (addressed?, stop scope fallback). Magic words should stay rare and narrowly scoped because they override normal conversation intake behavior.
- **Bare command**: A command phrase accepted without a leading slash. Bare commands should be limited to `session`; other commands require slash form to avoid accidental activation. `stop` is not treated as a normal bare command because it is a magic word.
- **Slash command**: A minimal chat control for essential, frequently needed actions. Slash commands are not a complete configuration surface and should not mirror every Admin capability.
- **Admin**: The complete operator-facing configuration surface. Detailed or infrequent settings belong in Admin rather than slash commands.
- **Platform Adapter**: Slack, Discord, Telegram, or GitHub code that translates platform SDK events into mikan conversation events and provides platform-specific response operations.
- **Response source**: Platform-neutral assistant-authored content expressed as standard Markdown/GFM. A Platform Adapter owns conversion from the response source into the platform's native presentation format; platform-native markup is not part of the response source contract, and an adapter must never steer the model toward platform-native markup — conversion is wholly the adapter's responsibility.
- **Progressive renderer**: The Platform Adapter module that owns how an in-progress response becomes a visible platform message over time — provisional renders while text accumulates, then one canonical final render. Callers never learn which platform mechanism (native streaming or message edits) produced the display.
- **Session key**: The office's platform session reference used to serialize and resume work for a direct message, shared channel, or thread. A session key belongs to exactly one conversation: either the bare conversation identity or that identity plus an opaque scoped suffix. It is a platform value, not globally unique — runtime state is always addressed by the Conversation office's `OfficeAddress` plus the session key, so a session key can never select another office's runtime state, even across platforms that share raw conversation IDs.
- **Session suffix**: The opaque platform thread, reply-root, or message identity after the session-key separator. It may distinguish scoped sessions but is never a separate conversation identity; path-dangerous values are invalid.
- **Scheduled event**: A JSON file in the workspace `events/` directory (the workspace scheduling bus) that triggers an autonomous agent run — immediate, one-shot (`at`), or periodic (`schedule` + `timezone`). The event-format module (`src/harness/event-format.ts`) is the single owner of the file format: schema, payload union, parser, builder, and per-type field rules. Every reader and writer (the events watcher, the `event` tool, the extension schedule API) goes through it.
- **Subagent dashboard**: The response-source Markdown rendering of a run's subagent progress. The snapshot module (`src/subagent-progress.ts`) owns the progress snapshot end to end — construction bounds, parsing off the tool-update transport, the status tables, settling, merging, and the Markdown rendering — and the harness composes "dashboard, blank line, answer" through `replaceResponse` like any response. A responder overrides `replaceSubagentProgress` only to convert the snapshot for a pipeline that is not response-source Markdown (today Telegram's HTML).

## Execution surfaces

- **Default office runtime**: The persistent, single-node Sandbox runtime assigned to one Conversation office. It provides strong environment isolation and a durable Workspace projection that survives turns and runtime restarts. `image:*`, Gondolin, and eventually a correctly provisioned Firecracker runtime belong here. _Avoid_: treating a remote ephemeral worker as a default office.
- **Office coworker**: A bounded Subagent launched inside a Default office runtime to help with a task. Coworkers share the office's authorized working context and are intentionally limited in number; they are not elastic factory capacity.
- **Factory floor**: An elastic execution surface for repetitive, outsourced, or highly parallel work. Each factory job receives a temporary environment and temporary data, returns an explicit result, and is then discarded. Kubernetes Agent Sandbox, Cloud Run sandbox, Cloudflare Sandbox, and E2B are intended future adapters. A Factory floor is not a Conversation office and never becomes the default persistent runtime.
- **Factory worker**: A Subagent assigned to one ephemeral Factory floor job. It receives only explicitly packaged inputs and capabilities, cannot assume durable local state, and must return all durable results before teardown.
- **Task executor**: The lower-level ephemeral command surface behind a Factory floor or an extension tool: one task in, explicit output back, no persistent Workspace projection. A future Factory worker may orchestrate several task executions, but persistence still belongs to the Default office runtime.
- **Sandbox runtime**: A persistent execution environment capable of holding a Workspace projection across turns. In the office model, this is the agent's computer. _Avoid_: using the term for ephemeral factory capacity merely because that capacity is isolated.

### Deployment constraint

Default office runtimes are single-node by design. Moving a live office between nodes requires durable workspace transport, communication routing, and migration semantics that mikan does not currently promise. Elastic multi-node capacity belongs to the Factory floor, where jobs and data are disposable by contract.

## Workspace, isolation, and communication

- **Conversation office**: One conversation's personal working area and persistent data boundary. It contains the conversation's workspace and is paired with an independent Sandbox runtime. _Avoid_: treating a conversation office as merely a directory.
- **Door policy**: The data-access policy around a Conversation office. The default locked policy enforces file isolation; a trusted organization may explicitly choose an unlocked policy for collaboration. Door policy does not change execution-environment or network isolation.
- **Isolated workspace**: The default, locked Door policy. A conversation can access its own data but cannot directly access shared or other conversations' data without an explicit capability. _Avoid_: `private`, which does not state whether the boundary is a security guarantee.
- **Trusted workspace**: An explicit, unlocked Door policy for a mutually trusted organization. Conversation data remains spatially separated to prevent mistakes, but cross-conversation and shared-data access may be enabled and is not a strong file-security boundary. _Avoid_: open workspace, private workspace.
- **Conversation communication**: Host-mediated communication between Conversation offices. Calls provide request/response delegation; messages provide durable asynchronous delivery. Communication passes messages or work results, not filesystem access or execution-environment ownership.
- **Shared bulletin**: Organization-level information intentionally published for multiple conversations. Read and write capabilities are independent of Conversation communication and Door policy.
- **Workspace**: One mikan deployment's organizational agent world: its Conversation offices, shared information, and communication facilities. A Workspace is not necessarily one trust domain; its Door policy determines whether conversation data boundaries are enforced.
- **Workspace projection**: The explicit data view presented to a Sandbox runtime. Under the default Isolated workspace policy it contains only the conversation's authorized data; a Trusted workspace policy may project shared or cross-conversation data.
- **Office registry**: The host-only directory of Conversation offices (`office-registry.json` in the State dir). Office directories are named by office key — platform-scoped, collision-resistant, and not reversible to raw platform ids — so the registry records each office's `(platform, conversationId)` at creation and journals legacy-directory migrations. Raw-id-scoped surfaces (Admin) resolve offices through it.
- **Host workspace root**: The directory on the mikan host machine that stores workspace data.
- **Runtime workspace root**: The path at which an authorized Workspace projection appears inside a conversation's Sandbox runtime. The model only ever sees runtime paths.
- **State dir**: mikan's host-only private storage for settings, credentials, extension code, and extension data. It is never part of a Workspace projection.

## Security boundaries

- **Execution isolation**: Every Conversation office uses an independent Sandbox runtime—the agent's computer. Trusted workspace policy never weakens this boundary.
- **Data isolation**: Conversation files are protected by the default Isolated workspace policy. Trusted organizations may explicitly relax this boundary without changing environment isolation.
- **Open network**: Sandbox runtimes have unrestricted network connectivity by default. Authority comes from explicitly injected credentials and capabilities, not network reachability.
