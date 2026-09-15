# src/events

Scheduled-event protocol, office-confined store, and in-memory scheduler.

## Ownership

- `index.ts` owns the persisted payload contracts, JSON wire schema, payload parsing/building, filename validation, the `OfficeEventStore`, and the legacy-bus migration.
- `scheduler.ts` owns timer/cron lifecycle across every registered office and delivery through platform-neutral `MessagingBot` ports.

The agent-facing `event` tool is not part of this module. It lives in `src/harness/tools/event.ts` and receives an `OfficeEventStore` bound to the running office. The Admin Web adapter constructs the same store per office. Neither parses event files independently.

## Location and access

Records live under `<state dir>/conversations/<office-key>/events/*.json`. No sandbox layout mounts this directory: agents reach their office's events only through the `event` tool, and only their own office's records exist from the store's point of view. Another office's filename is "not found"; `create` never overwrites; payloads must address the store's own office. Cross-office scheduling is not a feature of this module — it belongs to the explicit grants in [the Office policy](../../docs/office-policy.md), which are not implemented.

## Lifecycle

The scheduler loads every registered office's records once at `start()`; afterwards its only inputs are store mutations through `EventScheduleSink` (`scheduleRecord`/`cancelRecord`). There is no filesystem watcher, so a hand-edited file takes effect on the next start. `delete` cancels the timer or cron before the file is removed, and `update` replaces the schedule atomically. Immediate and one-shot records are removed after enqueue (including queue-full discards, which are reported); periodic records stay until deleted. `stop()` cancels every pending timer and cron.

Legacy `<workspace>/events/*.json` records are moved by `mikan office migrate-events` when they carry an explicit platform matching a registered office; everything else is reported and left in place.
