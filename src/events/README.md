# src/events

Scheduled-event protocol, host store, and watcher.

## Ownership

- `index.ts` owns the persisted payload/store contracts, JSON wire schema, payload parsing/building, filename validation, and host-side reads/writes for the workspace `events/` bus.
- `watcher.ts` owns filesystem watching, timer/cron lifecycle, and delivery through platform-neutral `MessagingBot` ports.

The agent-facing `event` tool is not part of this module. It lives in `src/harness/tools/event.ts` and calls the events-owned store/protocol interfaces. It only lists records with an exact current platform/conversation owner, checks ownership before read/update/delete, and rejects global enumeration even for direct or persisted calls. Legacy records without platform identity remain parseable by this module but are not attributed to an agent Office.

These tool checks are not a system-wide authorization guarantee: the store is still unscoped, creation can overwrite a colliding filename, and agent-writable event files can change between an ownership read and a mutation. Admin and the filesystem watcher remain separate entry points. See [the target Office policy](../../docs/office-policy.md) before extending this interface.

## Compatibility and lifecycle

Event files remain JSON files under `<workspace-root>/events/`. Their accepted fields, serialized payload shape, filename rules, and legacy parsing behavior are compatibility-sensitive. The watcher starts only after platform bots are initialized and `stop()` closes the filesystem watcher and cancels debounce timers, scheduled timers, and cron jobs.

The Admin Web adapter consumes `EventStore` rather than parsing event files independently. Platform delivery crosses the common `MessagingBot` interface; this module does not depend on a platform adapter implementation.
