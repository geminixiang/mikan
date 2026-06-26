# src

This directory is the TypeScript source root for mikan; the entries below describe files located directly in this directory.

## Files

- `adapter.ts`: Defines platform-neutral chat messages, bots, response contexts, events, and running-session interfaces.
- `agent.ts`: Builds the Pi coding agent runner, including prompt, memory, skills, tools, sandbox, vault, and response flow.
- `config.ts`: Loads, normalizes, and saves global and conversation settings for models, sandbox, auto-reply, and portal URLs.
- `context.ts`: Finds platform messages by message id from a conversation `log.jsonl` file.
- `download.ts`: Downloads Slack channel history and prints top-level messages with thread replies.
- `events.ts`: Watches `events/` JSON files and fires immediate, one-shot, and periodic bot events.
- `execution-resolver.ts`: Resolves the concrete executor and credential injection for an actor, conversation, vault, and sandbox.
- `index.ts`: Exposes the package public API through barrel exports.
- `log.ts`: Centralizes CLI log formatting for messages, tools, responses, usage, startup, and backfill.
- `main.ts`: CLI entrypoint that parses arguments and starts config, sandbox, vault, runtime, portal, events, and platform bots.
- `portal-shell.ts`: Renders the shared HTML shell, navigation, and CSS for admin/session/vault portals.
- `provisioner.ts`: Manages per-vault Docker image sandbox containers, mounts, resource limits, boosts, and idle shutdown.
- `store.ts`: Manages channel directories, `log.jsonl` message logging, Slack attachment downloads, and deduplication.
- `trigger.ts`: Decides whether a message should trigger the agent, including auto-reply rules and LLM judging.
- `platform-messages.ts`: Centralizes product name and cross-platform bot status messages for stopping, stopped, already-working, and idle states.

## Subdirectories

- `adapters/`: Chat platform adapters and shared adapter utilities.
- `commands/`: Chat command parsing and handlers.
- `observability/`: Sentry initialization, error reporting helpers, and startup instrumentation.
- `web/`: Web portals — admin, login/OAuth, and session view.
- `runtime/`: Conversation and session runtime orchestration.
- `sandbox/`: Host/container/image/firecracker/cloudflare sandbox abstractions and executors.
- `session-view/`: Session View command, portal, model loader, and token storage.
- `sessions/`: Chat-history synchronization, session file management, and session policy.
- `tools/`: Agent tools such as read, bash, edit, write, event, and sandbox.
- `utils/`: Low-level utilities — environment variable reading, atomic file writes, safe JSON/text helpers, and HTML escaping.
- `vault/`: File-backed credential vault implementation and vault-key routing.
