# src/runtime

This directory coordinates conversation and session runtime execution.

## Files

- `conversation-runtime.ts`: The `MessagingEventHandler` behind every platform bot. Owns the whole run path: per-session-key queueing (`handleEvent` serializes events on one key), command dispatch, runner creation/caching, run instrumentation (Sentry span/metrics), stop/new actions, idle eviction, and graceful shutdown. Portal services (vault manager, link/session-view/admin token stores) are optional — embedders that construct the runtime without them get disabled defaults, and the command handlers reply "not configured" instead of failing.
- `session-lifecycle.ts`: Owns the per-session-key state and queue maps behind the runtime: state get/set, serialized queueing, idle eviction, and the max-session cap.
- `types.ts`: Runtime state, options, and the public `ConversationRuntime` interface.
