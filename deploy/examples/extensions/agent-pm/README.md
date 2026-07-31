# agent-pm — mikan extension example

An event-driven team-operations pipeline: **Event → Workflow → Task → Feedback**.

Everything that happens — a chat message, a repository change, a calendar
entry, a clock tick — lands as one immutable `Event`. Registered `Workflow`
rows (a trigger, a prompt, and a declared tool list) match events and run; when
something needs a person, they produce a `Task`. The person works it and says
whether the agent was right, and that judgement is `Feedback` that shapes the
next run of the same workflow. Human replies come back in as Events, so the
loop closes without a separate tracking stage.

Zero **runtime** dependencies: storage is the Node built-in `node:sqlite`, on
the same Node `>=22.19.0` baseline as mikan. Types come from the mikan package
(a dev dependency) via `import type { MikanExtensionApi }`; jiti loads the
TypeScript directly, so there is no build step.

This is the large example. For the minimal shape of an extension — one
interactive message and one handler — read [`../poll`](../poll) first.

## What it demonstrates

| Extension surface                                                                | Where                               |
| -------------------------------------------------------------------------------- | ----------------------------------- |
| **Callback schedules** — host-side code on a cron, no agent run, no model call   | `src/index.ts`, the pipeline stages |
| `api.notify` **returning the message id** — the thread anchor a reply loop needs | `src/delivery.ts`                   |
| `registerTool` with a typed JSON-Schema tool                                     | `pm_task` in `src/index.ts`         |
| `registerCommand` — deterministic `/pm`, dispatched with no model call           | `src/index.ts`                      |
| `api.subagent.run` with an output schema, for the one routing decision           | `src/pipeline/run.ts`               |
| `api.paths.sharedDataDir` — a deliberately cross-conversation application        | `src/index.ts`                      |
| `mikan.secrets` declaration                                                      | `package.json`                      |
| Bundled skills, inlined into the prompt                                          | `skills/task-triage/`               |

## Layout

```
src/
  index.ts            activate: schedules, the pm_task tool, the /pm command
  config.ts           config.json — delivery mode, schedule overrides
  context.ts          what every stage is handed
  db.ts               schema (8 pipeline tables + identity) and row types
  store.ts            the one place rows are written
  urn.ts              subject URNs
  clock.ts            the one clock
  delivery.ts         the single outbound log
  pipeline/           ingest → run → sweep, one file per stage
  workflows/          seeds.ts (the rows) and handlers.ts (the code)
```

## Four ideas worth stealing

**Deliveries are one table with a unique key.** Every outbound message goes
through `deliver()`, so "don't send this twice" is a database constraint
instead of a check each call site re-implements. Re-running a stage posts
nothing rather than notifying everyone again.

**`deliveryMode` defaults to `test`.** Every message is divertible to one
conversation, labelled with where it would have gone. An extension that
notifies people is one config mistake away from notifying all of them twice —
while you tune a workflow, or while this runs beside whatever it replaces.

**Schedules are owned by exactly one conversation.** `activate` runs once per
conversation, so without the `controlConversationId` check every conversation
the extension is installed in registers its own copy of the daily jobs.

**An unmatched event is recorded, not dropped.** A routing gap and a quiet day
look identical unless you write down that nothing matched.

## Install

```sh
# from GitHub, no local clone
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --global

# or from a local path
mikan ext install ./agent-pm --conversation <id>
```

Send `/pi-new` in the conversation to activate. Installation copies the source
into the host-only state directory, so editing the original checkout does not
update the installed copy — re-run the same command to replace code while
preserving data. No process restart is needed: each new harness instance loads
extensions through jiti with no module cache.

Then configure it:

```jsonc
// <stateDir>/global/extension-data/agent-pm/config.json
{
  "controlConversationId": "C0EXAMPLE1", // owns the schedules; also the delivery target
  "deliveryMode": "test", // "live" once you have compared the output
  "testConversationId": "C0EXAMPLE2",
  "heartbeatHour": 9, // Asia/Taipei
  "scheduleOverrides": {}, // e.g. {"run-workflows": "*/2 * * * *"}
}
```

Until `controlConversationId` is set nothing fires on a timer — the tool and
the command still work, and `/pm status` says so.

> To develop your own extension, install mikan for types with
> `npm install --save-dev --ignore-scripts @geminixiang/mikan`, import
> `MikanExtensionApi`, then implement `activate(api: MikanExtensionApi)`.
> `mikan ext dev ./my-extension` runs it in a stdin/stdout conversation.

## Commands

- `/pm status` — delivery mode, schedule ownership, queue depth, failure counts
- `/pm ingest | run | sweep | all` — run a stage now, without waiting for cron

Extension commands are dispatched deterministically, with no model call. Slack
intercepts `/`-prefixed input in its own client and only delivers commands
registered in the Slack app manifest, so `/pm` is reachable from Telegram,
Discord, and GitHub comments — and from the Slack Web API, which is how the
end-to-end test drives it.

## Tests

- `src/test/example-agent-pm.test.ts` — the pipeline end to end against a stub
  api: idempotent ingest, unmatched events recorded, delivery dedup, test-mode
  routing, run attribution.
- `e2e/slack/agent-pm.e2e.ts` (S-023, S-024) — the mikan↔extension seam against
  a real workspace: a contributed command arriving without a model call, and
  `api.notify` actually posting.

## Not implemented here

The ingest sources (chat, repository, calendar) and `improve_workflows` are
left out: they need credentials and an organization's own identity data, which
would make this a deployment rather than a reference. `pipeline_heartbeat` is
the one shipped workflow, and it exercises every seam the others would use.
