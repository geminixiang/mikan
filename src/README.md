# src

This directory is the TypeScript source root for mikan; the entries below describe files located directly in this directory.

## Files

- `content.config.ts`: Declares the Starlight `docs` content collection for the documentation site.
- `env-manifest.ts`: Declares the daemon's environment-variable interface as data; startup validation, `mikan env`, `--help`, and the pm2 deploy-template check derive from it. Also owns the read/write convention itself: `readEnv` (accepts `MIKAN_`-prefixed aliases) and `setEnvAliases`.
- `file-guards.ts`: Provides guarded optional text/JSON reads, JSON value parsing, record checks, directory creation, atomic/private file replacement primitives, and the state-dir-outside-workspace placement guard.
- `index.ts`: Exposes the package public API through barrel exports — commands, harness, sessions, runtime, sandbox, and the office values (`createWorkspace`, `createOfficeAddress`, `officeKey`, `Office`/`Workspace` types).
- `log.ts`: Centralizes CLI log formatting for messages, tools, responses, usage, startup, and backfill.
- `main.ts`: CLI entrypoint that executes the boot plan from `cli/boot.ts` and starts config, sandbox, vault, runtime, portal, events, memory capture, and platform bots.
- `types.ts`: Cross-module domain types that no single module owns — office identity aliases, sandbox settings, event payload re-exports, and portal shell options.

## Subdirectories

- `adapters/`: External adapters for chat platforms, Web HTTP/OAuth/admin/session-view surfaces, shared chat commands (`commands/`), and adapter utilities.
- `cli/`: CLI argv grammar (`boot.ts`) and the non-daemon subcommands (`office`, `env`, `onboard`, `--download`).
- `content/`: Starlight documentation source (`docs/` plus per-locale translations).
- `memory-capture/`: Post-run capture of durable knowledge into the conversation `MEMORY.md`, gated by Jev.
- `events/`: Scheduled-event wire protocol, host store, and watcher lifecycle.
- `harness/`: Agent execution — `createRunner`, prompt and presentation, actor/executor resolution, native Pi session integration, generic agent tools, models, MCP capabilities, skills, and bounded subagents.
- `observability/`: Vendor-neutral tracing, metrics, error reporting, privacy filtering, OTLP/HTTP protobuf export, optional Sentry issue integration, and startup/shutdown instrumentation.
- `office/`: The Conversation office module — canonical identity (`OfficeAddress`/office keys), the Workspace/Office layout values, workspace projection policy, the durable office registry journal, and the boot-time legacy migration.
- `runtime/`: Conversation and session runtime orchestration.
- `sandbox/`: Host/container/image/cloudflare sandbox abstractions and executors, including managed Docker container provisioning and lifecycle.
- `settings/`: Owner of `settings.json` at global and office scope — schema, scope merge, the writer seam that keeps cached runners and disk coherent, and one-time settings migrations. See `settings/README.md`.
- `sessions/`: Chat-history synchronization, single-writer session-tree storage, session file management, and session policy.
- `test/`: The whole test suite (unit, integration, and e2e specs) for every module above.
- `vault/`: File-backed credential vault implementation, vault-key routing, and credential injection.
