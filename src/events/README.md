# src/events

Scheduled-event protocol, office-confined store, and in-memory scheduler, and the watcher that reports background shell jobs.

## Ownership

- `index.ts` owns the persisted payload contracts, JSON wire schema, payload parsing/building, filename validation, and the `OfficeEventStore`.
- `scheduler.ts` owns timer/cron lifecycle across every registered office and delivery through platform-neutral `MessagingBot` ports.
- `jobs.ts` owns background job records, the watcher that reports a job's end, the job notice ID (`job:<id>`), and the names and limits the `bash_background` tool repeats to the model.

The agent-facing `event` tool is not part of this module. It lives in `src/harness/tools/event.ts` and receives an `OfficeEventStore` bound to the running office. The Admin Web adapter constructs the same store per office. Neither parses event files independently.

## Location and access

Records live under `<state dir>/conversations/<office-key>/events/*.json`. No sandbox layout mounts this directory: agents reach their office's events only through the `event` tool, and only their own office's records exist from the store's point of view. Another office's filename is "not found"; `create` never overwrites; payloads must address the store's own office. Cross-office scheduling is not a feature of this module — it belongs to the explicit grants in [the Office policy](../../docs/office-policy.md), which are not implemented.

## Lifecycle

The scheduler loads every registered office's records once at `start()`; afterwards its only inputs are store mutations through `EventScheduleSink` (`scheduleRecord`/`cancelRecord`). There is no filesystem watcher, so a hand-edited file takes effect on the next start. `delete` cancels the timer or cron before the file is removed, and `update` replaces the schedule atomically. Immediate and one-shot records are removed after enqueue (including queue-full discards, which are reported); periodic records stay until deleted. `stop()` cancels every pending timer and cron.

## Background jobs

`BackgroundJobs` (ADR 0033) is the host side of the `bash_background` tool (`src/harness/tools/bash-background.ts`), which receives it as a `BackgroundJobSink`. The tool registers a job before it starts the wrapper, so a job never runs without a record.

- **Records are host-only.** `<state dir>/conversations/<office-key>/jobs.json` holds each job's owning session, thread, user, and guest directory. A notice is routed from this record alone. The guest writes `<office dir>/.jobs/<id>/{log,pid,exit}`, and the watcher takes one thing from there: the exit code (digits, 0–255, in a file of at most 16 bytes), read through directories opened without following links and a file opened with `O_NOFOLLOW`, because the guest can replace any of them with a link that resolves on the host. It never reads `log`: the notice names the log and carries none of it, so a job's output reaches the model only through `bash`, whose results are redacted. The host deletes nothing under `.jobs`.
- **Delivery.** A notice is a `ConversationEvent` that names the owning session, offered to the platform's `enqueueEvent`. The job is marked delivered only when the platform accepts it; a refused notice (a full queue, a stopped bot) is offered again on the next poll. A notice accepted but not yet run when the process stops is lost, as a queued message is.
- **Limit.** A job that has no exit file after `JOB_LIMIT_MS` becomes terminal first and is then killed through the `JobContainers.exec` port, so the exit file the wrapper writes after the kill cannot produce a second notice. A job whose container stopped is reported the same way at the limit; nothing inspects the container.
- **Lifecycle.** `restore()` reads every registered office's records and retains the containers of running jobs; the composition root calls it before the provisioner's first idle check. `start()` begins polling and must follow the bots' `start()`, because an event that opens a Slack office before its continuation scan aborts that office's interrupted runs (ADR 0027). Only jobs without a delivered notice are polled; delivered records are dropped after seven days.
- The module takes its container operations as a port and imports nothing from `src/sandbox/`.
