# src/runtime

This directory coordinates conversation and session runtime execution.

Runtime state carries the office as its identity: `ConversationRuntimeState`
and the `ConversationRuntime` methods take an `OfficeAddress`, while
`sessionKey` stays the raw platform session-key grammar. Storage paths and
settings are reached through the `Office` value, never rebuilt from the raw
id.

## Files

- `conversation-runtime.ts`: The `MessagingEventHandler` behind every platform bot. Owns conversation orchestration: command dispatch, thread/rotation workflow, run instrumentation (Sentry span/metrics), and stop/new actions. It asks `SessionLifecycle` for a leased runner instead of manipulating runner ownership itself. Incremental chat-history persistence is awaited before extension dispatch or the agent prompt. Portal services (vault manager, link/session-view/admin token stores) are optional — embedders that construct the runtime without them get disabled defaults, and the command handlers reply "not configured" instead of failing. Platform capability packs arrive as factories, so each runner instantiates its own pack (bind state is per-runner) and core stays platform-neutral.
- `session-lifecycle.ts`: The runner resource authority behind the runtime. It owns `(OfficeAddress, sessionKey)` serialization, materialization single-flight, cached-runner leases, generation-based invalidation, run and Session Dream settlement, exact writer handover during disposal, idle/cap eviction, and shutdown. A cached runner is the sole writable pi v4 session handle for its file: lifecycle reuse checks the expected file before scope resolution can open the same path, and active leases prevent invalidation or eviction until their work settles.
- `types.ts`: Runtime state, lifecycle/runtime options, and the public `ConversationRuntime` interface.
