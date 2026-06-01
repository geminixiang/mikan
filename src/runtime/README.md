# src/runtime

This directory coordinates conversation and session runtime execution.

## Files

- `conversation-orchestrator.ts`: Coordinates one conversation run by handling commands, preparing a runner, executing the agent, and recording Sentry metrics.
- `index.ts`: Re-exports the session runtime API.
- `session-runtime.ts`: Manages session state/queues, stop/new actions, runner caching, idle eviction, and graceful shutdown.
