# src

This directory is the TypeScript source root for mikan; the entries below describe files located directly in this directory.

## Files

- `adapter.ts`: Defines platform-neutral chat messages, bots, response contexts, events, and running-session interfaces.
- `agent-events.ts`: Broadcasts agent event envelopes over server-sent events to connected session-view clients, and serves the `/api/agent-events/stream` endpoint.
- `agent/`: Agent runner — prompt authority, resource catalog, execution binding, run presentation, and the `createRunner` composition root.
- `config.ts`: Loads, normalizes, and saves global and conversation settings for models, sandbox, auto-reply, and portal URLs. Conversation-scoped functions take an `Office` and read/write the host-only office state dir; a legacy `<office dir>/settings.json` is migrated once and never read again.
- `content.config.ts`: Declares the Starlight `docs` content collection for the documentation site.
- `env-manifest.ts`: Declares the daemon's environment-variable interface as data; startup validation, `mikan env`, `--help`, and the pm2 deploy-template check derive from it. Also owns the read/write convention itself: `readEnv` (accepts `MIKAN_`-prefixed aliases) and `setEnvAliases`.
- `events.ts`: Watches `events/` JSON files and fires immediate, one-shot, and periodic bot events.
- `execution-resolver.ts`: Resolves the concrete executor and credential injection for an actor, office, vault, and sandbox.
- `index.ts`: Exposes the package public API through barrel exports — commands, harness, sessions, runtime, sandbox, and the office values (`createWorkspace`, `createOfficeAddress`, `officeKey`, `Office`/`Workspace` types).
- `log.ts`: Centralizes CLI log formatting for messages, tools, responses, usage, startup, and backfill.
- `main.ts`: CLI entrypoint that executes the boot plan from `cli/boot.ts` and starts config, audit, sandbox, vault, runtime, portal, events, and platform bots.
- `platform-messages.ts`: Centralizes product name and cross-platform bot status messages for stopping, stopped, already-working, and idle states.
- `provisioner.ts`: Manages per-vault Docker image sandbox containers, mounts, resource limits, boosts, and idle shutdown; also carries containers through the office-key rename and mount drift without losing their writable layer.
- `settings-mutation.ts`: The one writer seam for settings mutations that affect live conversations; chat commands and the Admin portal write through it so cached runners and disk never disagree.
- `subagent-progress.ts`: Owns the subagent progress snapshot end to end — producer construction, consumer parsing, display bounds, status tables, and response-source rendering — because the snapshot crosses an untyped tool-update transport.
- `trigger.ts`: Decides whether a message should trigger the agent, including auto-reply rules and LLM judging.
- `types.ts`: Cross-module domain types that no single module owns — office identity aliases, sandbox settings, workspace door policy/layout, event payload re-exports, and portal shell options.

## Subdirectories

- `adapters/`: Chat platform adapters and shared adapter utilities.
- `audit/`: Deployment-owned metadata-only agent-loop audit, SQLite worker/projections, retention, health, and Admin query seam.
- `cli/`: CLI argv grammar (`boot.ts`) and the non-daemon subcommands (`ext`, `office`, `--download`).
- `commands/`: Chat command parsing and handlers.
- `content/`: Starlight documentation source (`docs/` plus per-locale translations).
- `harness/`: mikan's agent harness — session store, model catalog, run loop, skills, subagents, and the extension system.
- `observability/`: Sentry initialization, error reporting helpers, and startup instrumentation.
- `office/`: The Conversation office module — canonical identity (`OfficeAddress`/office keys), the Workspace/Office layout values, the durable office registry journal, and the boot-time legacy migration.
- `packages/`: Git-sourced packages that ship extensions and skills — source grammar, materialization, per-conversation resolution, and the admin write path.
- `runtime/`: Conversation and session runtime orchestration.
- `sandbox/`: Host/container/image/cloudflare sandbox abstractions and executors.
- `sessions/`: Chat-history synchronization, session file management, and session policy.
- `test/`: The whole test suite (unit, integration, and e2e specs) for every module above.
- `tools/`: Agent tools such as read, bash, edit, write, event, react, generate_image, subagent, and sandbox.
- `utils/`: Low-level utilities — environment variable reading, atomic file writes, safe JSON/text helpers, HTTP body reading, and HTML escaping.
- `vault/`: File-backed credential vault implementation, vault-key routing, and credential injection.
- `web/`: Web portals — admin, login/OAuth, session view, and the agent-event stream.
- `workspace-projection/`: Resolves an office's door policy into the concrete sandbox mount list and the authorized prompt sources.
