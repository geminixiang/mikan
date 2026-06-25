# src/runtime

This directory coordinates conversation and session runtime execution.

## Files

- `agent-run-controller.ts`: Coordinates one conversation run by handling commands, preparing a runner, executing the agent, and recording Sentry metrics.
- `conversation-runtime.ts`: Manages session state/queues, stop/new actions, runner caching, idle eviction, and graceful shutdown.
