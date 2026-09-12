# src/events

Scheduled-event protocol, host store, and watcher.

## Ownership

- `index.ts` owns the persisted payload/store contracts, JSON wire schema, payload parsing/building, filename validation, and host-side reads/writes for the workspace `events/` bus.
- `watcher.ts` owns filesystem watching, timer/cron lifecycle, and delivery through platform-neutral `MessagingBot` ports.

The agent-facing `event` tool is not part of this module. It lives in `src/harness/tools/event.ts` and calls the events-owned store/protocol interfaces.

## Compatibility and lifecycle

Event files remain JSON files under `<workspace-root>/events/`. Their accepted fields, serialized payload shape, filename rules, and legacy parsing behavior are compatibility-sensitive. The watcher starts only after platform bots are initialized and `stop()` closes the filesystem watcher and cancels debounce timers, scheduled timers, and cron jobs.

The Admin Web adapter consumes `EventStore` rather than parsing event files independently. Platform delivery crosses the common `MessagingBot` interface; this module does not depend on a platform adapter implementation.
