---
title: Events
description: Event formats and processing flow for triggering the agent through the workspace events directory.
---

## Where events live

Event files live in `<workspace>/events/`, at the workspace root rather than inside any office directory. The scheduling bus is deliberately workspace-wide: one directory the watcher polls, shared by every conversation. It is also agent-writable, so ownership by `conversationId` is a cooperative convention, not an authorization boundary — do not put secrets in event text.

The agent's `event` tool lists only the current conversation's events by default: a file matches when its `conversationId` **and** its `platform` match the running office. Files written before payloads carried a `platform` stay visible to whichever conversation shares the raw id. `scope=all` lists everything in the directory.

## Event types

### Immediate

The harness triggers as soon as it sees the file. This is useful for signals from external scripts or webhooks.

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

Trigger once at a specified time. This is useful for reminders and future callbacks.

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

`at` must be an ISO 8601 timestamp ending in `Z` or an explicit `±HH:MM` UTC offset.

### Periodic

Trigger on a cron schedule. The file stays in place until it is deleted.

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

- `0 9 * * *` — every day at 09:00
- `0 9 * * 1-5` — weekdays at 09:00
- `0 0 1 * *` — midnight on the first day of every month

## Routing fields

`type`, `conversationId`, and `text` are required in every event file; the rest are optional, and per-type fields (`at`, `schedule` + `timezone`) are required for their own type. `src/harness/event-format.ts` owns the schema — every reader and writer goes through its parser and builder.

| Field              | Description                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `platform`         | Target bot platform, for example `slack`. Omitting it makes the file ambiguous when two platforms share a raw conversation id |
| `conversationId`   | Raw platform channel or DM ID to send to — not an office key. `channelId` is accepted as a legacy read-only alias             |
| `conversationKind` | `"shared"` (channel) or `"direct"` (DM)                                                                                       |
| `userId`           | Platform user ID that requested this event; used for vault/credential routing in per-user mode                                |

## Session binding

Event files do not carry a `sessionKey` or thread target. Event text must be self-contained because scheduled/background events are not a continuation of the live chat turn that created them.

| Platform/event source            | Visible delivery method           | Session key                            | Thread target     |
| -------------------------------- | --------------------------------- | -------------------------------------- | ----------------- |
| Slack event file/tool            | New top-level anchor message      | `<conversationId>:<anchor message ts>` | None              |
| Slack direct `ConversationEvent` | Provided `thread_ts` has priority | `<conversationId>:<thread_ts>` if set  | Optional          |
| Other platform events            | Platform adapter default          | Platform adapter default event session | Adapter-dependent |

For Slack event files, mikan first creates a top-level Slack message when the event fires. That message timestamp becomes the anchor, and the run uses the fixed session key `<conversationId>:<anchor message ts>`.

This makes event runs visible in the channel and isolates them from the persistent top-level session. Top-level channel history is still available in `log.jsonl` for explicit lookup, but it is not implicitly copied into the event session.

## Thread target

Events are delivered as top-level messages. They should not be buried inside old threads or reply chains.

The agent's `event` tool fills routing fields automatically. Use it instead of hand-writing JSON.

## Lifecycle

- **Immediate** and **one-shot** files are deleted after successful delivery.
- Invalid, expired, undeliverable, or queue-overflow immediate/one-shot files are also deleted; inspect logs or Sentry for the failure.
- **Periodic** files stay in place. Delete the file to cancel the event.
- At most 5 events can be queued at once. Additional immediate/one-shot files are discarded as described above.

## Silent responses

For periodic events that have nothing to report, respond exactly with `[SILENT]`. The harness deletes the status message and does not post to the platform, avoiding channel spam.

## Debouncing

When writing scripts that send immediate events, such as email watchers or webhook handlers, debounce them. Collect events inside a time window and send one summary event instead of one event per item.
