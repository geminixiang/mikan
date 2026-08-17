# src/runtime

This directory coordinates conversation and session runtime execution.

Runtime state carries the office as its identity: `ConversationRuntimeState`
and the `ConversationRuntime` methods take an `OfficeAddress`, while
`sessionKey` stays the raw platform session-key grammar. Storage paths and
settings are reached through the `Office` value, never rebuilt from the raw
id.

## Files

- `conversation-runtime.ts`: The `MessagingEventHandler` behind every platform bot. Owns the whole run path: per-session-key queueing (`handleEvent` serializes events on one key), command dispatch, runner creation/caching, run instrumentation (Sentry span/metrics), stop/new actions, idle eviction, and graceful shutdown. A cached runner is the sole writable pi v4 session handle for its file: existing state is reused before scope resolution can open the same path, and incremental chat-history persistence is awaited before extension dispatch or the agent prompt. An event carrying a durable session UUID is resolved through the Sessions authority before queueing; the exact historical file is resumed under its runtime-compatible session key without changing the office's `current` pointer, and invalid targets fail closed. Portal services (vault manager, link/session-view/admin token stores) are optional — embedders that construct the runtime without them get disabled defaults, and the command handlers reply "not configured" instead of failing. Platform capability packs arrive as factories, so each runner instantiates its own pack (bind state is per-runner) and core stays platform-neutral.
- `session-lifecycle.ts`: Owns the per-session-key state and queue maps behind the runtime: state get/set, serialized queueing, idle eviction, and the max-session cap.
- `types.ts`: Runtime state, lifecycle/runtime options, and the public `ConversationRuntime` interface.
