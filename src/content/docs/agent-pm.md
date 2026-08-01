---
title: agent-pm
description: Using the team-operations pipeline — what it brings you, how to work a task, and why your answer changes what it does next.
---

agent-pm watches the things that happen around a team and brings you only the
ones that need a person. It is an extension: someone installs it into a
conversation, and from then on you talk to it the same way you talk to mikan.

This page is for using it. If you are the one installing it, skip to
[For whoever deploys it](#for-whoever-deploys-it).

## The loop you are part of

Everything that happens — a message, a repository change, a clock tick — is
recorded as an **event**. Rules called **workflows** look at each event and
decide whether anything follows from it. When something needs judgement that
only a person has, the workflow creates a **task** and sends it to you.

Then the part that matters: when you close a task you say _how_ it ended, and
that answer is **feedback**. It is not bookkeeping. Closing a task as
`no_action_needed` tells the workflow it should not have asked, and that
judgement shapes what it does with the next similar event. A task closed
carelessly teaches it the wrong thing.

## What you will see

Tasks arrive as ordinary messages in the conversation that owns the pipeline.
Nothing is hidden in a separate tool you have to remember to check.

If the pipeline is running in **test mode**, every message is diverted to one
conversation and labelled with where it _would_ have gone. That is the default,
and it is deliberate — an extension that notifies people is one configuration
mistake away from notifying all of them, twice. Seeing labelled messages in a
test channel means it is working, not broken.

## Working a task

Ask in your own words. The agent has a tool for reading and closing tasks, so
you do not need a command:

> what's still open?
>
> show me task 12
>
> close task 12, it's handled — the deploy fixed it

When you close one, say what actually happened. Four outcomes exist, and they
mean different things to the workflow that created the task:

| Outcome            | Say this when                                                     |
| ------------------ | ----------------------------------------------------------------- |
| `resolved`         | the task was right, and you did the thing                         |
| `no_action_needed` | the task was raised, but nothing needed doing                     |
| `invalid`          | the task should not have existed — the workflow misread the event |
| `superseded`       | something else overtook it                                        |

The last two are the valuable ones. `no_action_needed` and `invalid` are how a
workflow learns it is asking too often, and they are recorded as feedback
against it. If you close everything as `resolved`, the pipeline never finds out
it is wasting your attention.

## Checking on it

```
/pm status
```

```
agent-pm — 2026-08-01 (Asia/Taipei)
delivery: test → C0EXAMPLE2
schedules owned by: this conversation
events: 5 total · 0 pending · 0 unmatched
tasks: 0 open · workflows: 1 enabled
deliveries sent: 1 · failed runs: 0
```

Reading it:

- **delivery** — `test` means messages are being diverted; `live` means they go
  where the workflow intended.
- **schedules owned by** — the pipeline's timers belong to exactly one
  conversation. If this says another conversation, the timers are running
  there; the command and the task tool still work here.
- **unmatched** — events no workflow claimed. A routing gap and a quiet day
  look identical unless you can see this number, which is why it is reported
  rather than dropped.
- **failed runs** — a workflow that errored. Persistent failures here are worth
  raising with whoever deployed it.

## Making it run now

```
/pm all
```

Runs every stage immediately instead of waiting for its timer: take in new
events, match them against workflows, then sweep for tasks that have gone
overdue. `/pm ingest`, `/pm run`, and `/pm sweep` do one stage each.

This is how you check that something is wired up without waiting an hour for
the next tick.

:::note[On Slack, prefix the command with a space]
Slack's own client intercepts anything starting with `/` and only sends
commands registered in the Slack app itself, so `/pm` never leaves your
machine. Typing ` /pm status` with a leading space sends it as an ordinary
message, and agent-pm still reads it as a command. Telegram, Discord and GitHub
comments have no such interception.
:::

## When nothing seems to happen

Most of the time this is expected rather than broken:

- **The control conversation is not configured.** Until it is, no timer fires
  at all. `/pm status` says so, and the command and task tool still work.
- **Nothing matched.** Check the `unmatched` count. Events arriving but nothing
  matching means a workflow is missing, not that the pipeline is stuck.
- **One workflow ships enabled.** What is installed by default is a heartbeat
  that proves the whole path works end to end. The interesting sources — your
  repository, your calendar, your chat history — are not included, because they
  need your organization's own credentials and identity data. Someone has to
  add them; see below.

## For whoever deploys it

Install it, then set the control conversation:

```sh
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --global
```

Send `/pi-new` in the conversation to activate, then edit
`<stateDir>/global/extension-data/agent-pm/config.json`:

```jsonc
{
  "controlConversationId": "C0EXAMPLE1", // owns the timers and receives deliveries
  "deliveryMode": "test", // switch to "live" once you have compared the output
  "testConversationId": "C0EXAMPLE2",
  "heartbeatHour": null, // null = first tick of the day, or pin an Asia/Taipei hour
  "scheduleOverrides": {}, // e.g. {"run-workflows": "*/2 * * * *"}
}
```

Leave `deliveryMode` on `test` until you have watched a full day of output and
agreed with it. Switching to `live` is the point at which a misrouted workflow
starts reaching real people.

agent-pm is also the reference example for building extensions of your own — it
exercises callback schedules, a typed tool, a contributed command, SQLite
persistence, proactive messaging, and bundled skills in one place. For that
side of it, read [Extension Development](/extension-development/) and the
[source](https://github.com/geminixiang/mikan/tree/main/deploy/examples/extensions/agent-pm).
