# src

This directory is the TypeScript source root for mikan; the entries below describe files located directly in this directory.

## Files

- `adapter.ts`: Defines platform-neutral chat messages, bots, response contexts, events, and running-session interfaces.
- `agent-events.ts`: Broadcasts agent event envelopes over server-sent events to connected session-view clients.
- `agent.ts`: Agent runner — prompt, paths, run lifecycle, and `createRunner` (single module).
- `config.ts`: Loads, normalizes, and saves global and conversation settings for models, sandbox, auto-reply, and portal URLs.
- `env-manifest.ts`: Declares the daemon's environment-variable interface as data; startup validation, `mikan env`, `--help`, and the pm2 deploy-template check derive from it.

- `events.ts`: Watches `events/` JSON files and fires immediate, one-shot, and periodic bot events.
- `execution-resolver.ts`: Resolves the concrete executor and credential injection for an actor, conversation, vault, and sandbox.
- `index.ts`: Exposes the package public API through barrel exports.
- `log.ts`: Centralizes CLI log formatting for messages, tools, responses, usage, startup, and backfill.
- `main.ts`: CLI entrypoint that executes the boot plan from `cli/boot.ts` and starts config, sandbox, vault, runtime, portal, events, and platform bots.
- `settings-mutation.ts`: The one writer seam for settings mutations that affect live conversations; chat commands and the Admin portal write through it so cached runners and disk never disagree.

- `provisioner.ts`: Manages per-vault Docker image sandbox containers, mounts, resource limits, boosts, and idle shutdown.
- `store.ts`: Manages channel directories, `log.jsonl` message logging, Slack attachment downloads, and deduplication.
- `trigger.ts`: Decides whether a message should trigger the agent, including auto-reply rules and LLM judging.
- `platform-messages.ts`: Centralizes product name and cross-platform bot status messages for stopping, stopped, already-working, and idle states.

## Subdirectories

- `adapters/`: Chat platform adapters and shared adapter utilities.
- `cli/`: CLI argv grammar (`boot.ts`) and the non-daemon subcommands (`ext`, `--download`).
- `commands/`: Chat command parsing and handlers.
- `content/`: Starlight documentation source (`docs/` plus per-locale translations).
- `harness/`: mikan's agent harness — session store, model catalog, run loop, skills, and the extension system.
- `observability/`: Sentry initialization, error reporting helpers, and startup instrumentation.
- `web/`: Web portals — admin, login/OAuth, and session view.
- `runtime/`: Conversation and session runtime orchestration.
- `sandbox/`: Host/container/image/agent-sandbox/cloudflare sandbox abstractions and executors.
- `sessions/`: Chat-history synchronization, session file management, and session policy.
- `tools/`: Agent tools such as read, bash, edit, write, event, and sandbox.
- `utils/`: Low-level utilities — environment variable reading, atomic file writes, safe JSON/text helpers, and HTML escaping.
- `vault/`: File-backed credential vault implementation and vault-key routing.
- `workspace-projection/`: Resolves a conversation's workspace-mount mode and the concrete sandbox mount list.
