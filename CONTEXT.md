# Context

## Domain terms

- **Conversation intake**: The platform-message entry flow that decides whether an incoming chat message should start an agent run. It includes magic-word recognition, trigger/auto-reply policy, attachment preparation, conversation log writing, busy policy, queue selection, and dispatch to the runtime handler.
- **Magic word**: A highest-priority chat control phrase that bypasses normal trigger policy and queueing rules, such as `stop`. Conversation intake owns the single magic-word grammar for every platform; platform adapters state only policy data (addressed?, stop scope fallback). Magic words should stay rare and narrowly scoped because they override normal conversation intake behavior.
- **Bare command**: A command phrase accepted without a leading slash. Bare commands should be limited to `session`; other commands require slash form to avoid accidental activation. `stop` is not treated as a normal bare command because it is a magic word.
- **Slash command**: A minimal chat control for essential, frequently needed actions. Slash commands are not a complete configuration surface and should not mirror every Admin capability.
- **Admin**: The complete operator-facing configuration surface. Detailed or infrequent settings belong in Admin rather than slash commands.
- **Platform Adapter**: Slack, Discord, or Telegram code that translates platform SDK events into mikan conversation events and provides platform-specific response operations.
- **Response source**: Platform-neutral assistant-authored content expressed as standard Markdown/GFM. A Platform Adapter owns conversion from the response source into the platform's native presentation format; platform-native markup is not part of the response source contract, and an adapter must never steer the model toward platform-native markup — conversion is wholly the adapter's responsibility.
- **Progressive renderer**: The Platform Adapter module that owns how an in-progress response becomes a visible platform message over time — provisional renders while text accumulates, then one canonical final render. Callers never learn which platform mechanism (native streaming or message edits) produced the display.
- **Session key**: The conversation-scoped runtime identity used to serialize and resume work for a direct message, shared channel, or thread. A session key belongs to exactly one conversation: either the bare conversation identity or that identity plus an opaque scoped suffix. Platform-provided session keys must never select another conversation's runtime state.
- **Session suffix**: The opaque platform thread, reply-root, or message identity after the session-key separator. It may distinguish scoped sessions but is never a separate conversation identity; path-dangerous values are invalid.
- **Scheduled event**: A JSON file in the workspace `events/` directory (the workspace scheduling bus) that triggers an autonomous agent run — immediate, one-shot (`at`), or periodic (`schedule` + `timezone`). The event-format module (`src/harness/event-format.ts`) is the single owner of the file format: schema, payload union, parser, builder, and per-type field rules. Every reader and writer (the events watcher, the `event` tool, the extension schedule API) goes through it.

## Execution surfaces

- **Sandbox runtime**: The machine a conversation's tool commands run on — the agent's computer. It receives a workspace projection and keeps it across turns, so what one turn writes the next turn still sees. Every `--sandbox=` mode is one. _Avoid_: treating isolation as the defining property — a persistent workspace is. An execution surface that cannot hold a workspace projection is a task executor, not a sandbox runtime.
- **Task executor**: An ephemeral, workspace-less execution surface that the agent or an extension calls as a tool — one command in, its output back, nothing kept. Suited to parallel fan-out and dynamic workflows. Never receives a workspace projection, so nothing it writes survives the call.

## Workspace & storage

- **Workspace**: One mikan deployment's shared agent world — its memory, skills, scheduled events, and conversations, as a single logical entity. A workspace is one trust domain: everything inside it may see and schedule everything else. _Avoid_: using bare "workspace" for any specific filesystem path — distinguish the host workspace root from the runtime workspace root.
- **Workspace projection**: The explicit mapping from the host workspace root into a sandbox runtime. `private` projects shared workspace memory, skills, events, and one conversation directory; `full` projects the entire Workspace. Both modes remain inside the single Workspace trust domain and are not tenant isolation.
- **Host workspace root**: The directory on the mikan host machine that stores the workspace.
- **Runtime workspace root**: The path at which the workspace appears inside a conversation's sandbox runtime (today `/workspace`). The model only ever sees runtime paths.
- **State dir**: mikan's host-only private storage (settings, credentials, extension code and data). Not part of the workspace and never mounted into a runtime — the host/sandbox trust boundary runs exactly between state dir and workspace.
