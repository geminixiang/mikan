---
title: Events
---

# Events

Events are JSON files written to the `events/` directory inside the workspace. The harness watches this directory and triggers the agent when a file appears.

## Event Types

### Immediate

Triggers as soon as the harness sees the file. Useful for signaling from external scripts or webhooks.

```json
{
  "type": "immediate",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "New GitHub issue opened"
}
```

### One-shot

Triggers once at a specific time. Use for reminders and future callbacks.

```json
{
  "type": "one-shot",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Remind Mario about dentist",
  "at": "2025-12-15T09:00:00+01:00"
}
```

`at` must be an ISO 8601 timestamp with UTC offset.

### Periodic

Triggers on a cron schedule. Persists until deleted.

```json
{
  "type": "periodic",
  "platform": "slack",
  "conversationId": "C123",
  "conversationKind": "shared",
  "userId": "U123",
  "text": "Check inbox and summarize",
  "schedule": "0 9 * * 1-5",
  "timezone": "Asia/Taipei"
}
```

Cron format: `minute hour day-of-month month day-of-week`

Common schedules:

- `0 9 * * *` — daily at 09:00
- `0 9 * * 1-5` — weekdays at 09:00
- `0 0 1 * *` — first of each month at midnight

## Routing Fields

| Field              | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `platform`         | Target bot platform (e.g. `slack`)                                                                   |
| `conversationId`   | Channel or DM ID to post into                                                                        |
| `conversationKind` | `"shared"` (channel) or `"direct"` (DM)                                                              |
| `userId`           | Platform user ID of whoever requested the event; used for vault/credential routing in per-user modes |

## Session Binding

Event files do not carry `sessionKey` or thread targeting. The event text must be self-contained because a scheduled/background event is not a continuation of the live chat turn that created it.

| Platform/event source   | Visible delivery          | Session key                            | Thread targeting |
| ----------------------- | ------------------------- | -------------------------------------- | ---------------- |
| Slack event file/tool   | New top-level anchor      | `<conversationId>:<anchor message ts>` | None             |
| Slack direct `BotEvent` | Provided `thread_ts` wins | `<conversationId>:<thread_ts>` if set  | Optional         |
| Other platform event    | Platform adapter default  | Platform adapter default event session | Adapter-specific |

For Slack event files, firing an event actively creates a top-level Slack message first. That message timestamp becomes the anchor and the run uses the fixed session key `<conversationId>:<anchor message ts>`.

This keeps event runs visible in the channel and isolates them from the persistent top-level session. The top-level channel history remains available in `log.jsonl` for explicit lookup, but it is not implicitly copied into the event session.

## Thread Targeting

Events are delivered as top-level messages. They should not be buried in a historical thread or reply chain.

The `event` tool (available to the agent) fills the routing fields automatically. Use it instead of writing JSON by hand.

## Lifecycle

- **Immediate** and **one-shot** files are deleted automatically after the event fires.
- **Periodic** files persist. Delete the file to cancel.
- Maximum 5 events can be queued at once.

## Silent Response

For periodic events with nothing to report, respond with exactly `[SILENT]`. The harness deletes the status message and posts nothing to the platform, avoiding channel spam.

## Debouncing

When writing scripts that emit immediate events (email watchers, webhook handlers), always debounce. Collect events over a window and emit one summary event rather than one event per item.
