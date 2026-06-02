# src

This directory is the TypeScript source root for mikan; the entries below describe files located directly in this directory.

## Files

- `adapter.ts`: Defines platform-neutral chat messages, bots, response contexts, events, and running-session interfaces.
- `agent.ts`: Builds the Pi coding agent runner, including prompt, memory, skills, tools, sandbox, vault, and response flow.
- `config.ts`: Loads, normalizes, and saves global and conversation settings for models, sandbox, auto-reply, and portal URLs.
- `context.ts`: Finds platform messages by message id from a conversation `log.jsonl` file.
- `download.ts`: Downloads Slack channel history and prints top-level messages with thread replies.
- `env.ts`: Reads environment variables with support for `MIKAN_`-prefixed aliases.
- `events.ts`: Watches `events/` JSON files and fires immediate, one-shot, and periodic bot events.
- `execution-resolver.ts`: Resolves the concrete executor and credential injection for an actor, conversation, vault, and sandbox.
- `file-guards.ts`: Provides safe directory creation, text/JSON/schema reads, JSON parsing, and record type guards.
- `fs-atomic.ts`: Atomically writes sensitive files with private file permissions.
- `index.ts`: Exposes the package public API through barrel exports.
- `instrument.ts`: Initializes state-dir environment aliases and Sentry early during startup.
- `log.ts`: Centralizes CLI log formatting for messages, tools, responses, usage, startup, and backfill.
- `main.ts`: CLI entrypoint that parses arguments and starts config, sandbox, vault, runtime, portal, events, and platform bots.
- `portal-shell.ts`: Renders the shared HTML shell, navigation, and CSS for admin/session/vault portals.
- `provisioner.ts`: Manages per-vault Docker image sandbox containers, mounts, resource limits, boosts, and idle shutdown.
- `sentry.ts`: Provides Sentry initialization, reporting helpers, metric attributes, and sensitive-data sanitization.
- `store.ts`: Manages channel directories, `log.jsonl` message logging, Slack attachment downloads, and deduplication.
- `tool-diagnostics.ts`: Decides which tool diagnostics should be surfaced back to chat.
- `trigger.ts`: Decides whether a message should trigger the agent, including auto-reply rules and LLM judging.
- `platform-messages.ts`: Centralizes product name and cross-platform bot status messages for stopping, stopped, already-working, and idle states.
- `vault-routing.ts`: Resolves vault keys from sandbox type, user, conversation, or container name.
- `vault.ts`: Implements the file-backed credential vault for env secrets, secret files, shared profiles, and mounts.

## Subdirectories

- `adapters/`: Chat platform adapters and shared adapter utilities.
- `admin/`: Admin portal and admin token storage.
- `commands/`: Chat command parsing and handlers.
- `login/`: Login/OAuth portal, login command parsing, and link token storage.
- `runtime/`: Conversation and session runtime orchestration.
- `sandbox/`: Host/container/image/firecracker/cloudflare sandbox abstractions and executors.
- `session-view/`: Session View command, portal, model loader, and token storage.
- `sessions/`: Chat-history synchronization, session file management, and session policy.
- `tools/`: Agent tools such as read, bash, edit, write, event, and sandbox.
