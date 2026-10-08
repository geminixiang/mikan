---
status: accepted
---

# Tasks run as background child conversations

A task becomes a child conversation in the office Harness, owned by a background task of the conversation that started it. pi-durable then keeps the task's work across a restart, and the requesting conversation receives its result. Today mikan builds tasks by hand in the Slack adapter, and a restart drops the work.

## Context

`start_task` follows Claude Tag, where every message posted to Slack is handled as background work: the requester hands over a self-contained brief and keeps talking. The tool description already says the task does not inherit the requester's tool history.

`start_task` is offered only in top-level Slack DMs, deliberately, to observe stability before opening it to channels. The Slack adapter posts an acknowledgement, records `taskRoot` on its office log entry, registers an empty thread session, and queues the brief on that session's Slack queue (`src/adapters/slack/bot.ts`). The task then runs as an ordinary ownerless session. `task_status` infers state from the office log's `taskRoot` entries and the runtime's running sessions (`src/adapters/slack/task-status.ts`). A reply in the task thread is classified by Jev and steered through the runtime steering port.

Because the task is an ordinary session, it shares the lifecycle of a foreground reply:

- **Shutdown waits for it.** `main.ts` drains conversation work for up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (5 minutes) and then aborts it. Slack intake is stopped during the drain.
- **Opening the office aborts it.** `OfficeStorage.abortUnfinishedWork` aborts every unfinished task whose record has no owner task, so nothing resumes the work after a restart.
- **The requesting conversation never learns the result.** The task's answer stays in its thread; a later question in the DM can only read its execution status.
- **The task session is offered the task tools.** `getTaskStatus` is set for every direct conversation, task threads included.

pi-durable provides the ownership model as public API (its README, "Abort and Subagents", and example `23-subagent-background.ts`). A task created with `{ background: true }` is a boundary: the requester's aborts and idle waits stop there. A conversation created with `ownership: { kind: "task", taskId }` starts as a copy of its owner conversation's agent and records its owner.

### Measurements

The restart rows ran against a local daemon on a test Slack workspace with a real model. `SIGTERM` is what a deploy sends; `kill -9` stands for a crash. The first table is the current code. The second is a prototype of this decision on branch `poc/task-durable`, driven from the Slack web client.

| Current code                                          | Result                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart while a task runs a 150 s command             | Shutdown waited about 2 minutes for the task to finish, then exited. Slack replies were stopped meanwhile.                                                                                                        |
| Restart while a task runs a 420 s command             | Shutdown aborted the run after 5 minutes. The thread showed only a failed tool call; the interruption notice went to the DM's top level. After the restart nothing resumed, and `task_status` reported `aborted`. |
| `start_task` called while the daemon is shutting down | The model answered that the task queue was closed.                                                                                                                                                                |
| Task thread doing the wrong work                      | 1 of 3 task starts: the task session called `task_status` instead of running the command, replied that the task was still running, and the thread was then marked finished.                                       |

| Prototype                                    | Result                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill -9` while a task runs a 120 s command  | After the restart the task resumed, reran the interrupted command, and posted the `date` output in its thread.                                                                         |
| `SIGTERM` while a task runs a 400 s command  | Shutdown finished in 1 s instead of waiting. After the restart the task resumed.                                                                                                       |
| Status, steer, and stop on a resumed task    | A status question in the DM reported the resumed task's current step; a steer in the thread was accepted for the next step; `stop` stopped it, and the next restart did not resume it. |
| Requester asked for the result without tools | The DM answered with the task's result, read from the report written to its transcript.                                                                                                |
| Sandbox command after the daemon exits       | It kept running. The resumed model checked for it and still started the command again, so two copies ran at once.                                                                      |
| `stop` on a container command                | Only the host `docker exec` client was killed; the command kept running. Fixed separately in 1.0.1: each command runs in its own guest process group, which stop and timeouts kill.    |

## Decision

1. **`start_task` creates the task in one commit on the requesting conversation**: a background anchor task, a child conversation owned by it, and the child's session index record. The runtime then queues the brief on the child's session like an incoming message, so the run gets its model binding, tools, budget, and presenter through the normal path.
2. **A task starts from its brief only.** It does not fork the requester's transcript or inherit its tool history, so each task is a self-contained piece of background work.
3. **The child is configured without `start_task` and `task_status`**, and with its own mikan extension.
4. **The outcome is written to the requester's transcript** as a write submission when a task run settles, so the requester knows the result without starting a model turn or posting another message. The task's thread still shows the answer.
5. **Opening office storage aborts the interrupted generation in every conversation, task children included, but never a background task.** pi-durable would otherwise drive the pending generation as soon as anything in the office submits, before the task's session is bound, and the request fails with no model binding.
6. **The runtime resumes a task with a new input.** At startup the Slack bot finds DM tasks whose run recorded a start in the last 24 hours and never recorded an end, posts a notice in the thread, and queues a resume prompt on the task's session. The prompt tells the model the step in progress was interrupted. Runs started before this change recorded no start time, so they never resume; a stopped task recorded an end. A task resumes at most twice without a run ending; the third interruption closes its run as aborted and posts one notice, because a step that kills the daemon would otherwise kill it on every restart for up to a day.
7. **Shutdown stops waiting for task runs.** The drain covers foreground runs only; task work is left to resume after the restart.
8. **Status and stop come from pi-durable state** (not yet done; status still reads the office log and the runtime). `task_status` reads each child's live run instead of the office log. Stop aborts the child. Steering stays as it is: Jev classifies a reply, and a steer is a `whenBusy: "steer"` submission to the child.
9. **Tasks open in three steps**, each after the previous one is stable:
   - Top-level Slack DMs, as today.
   - Top-level Slack channel messages, which start a task thread as in DMs.
   - Threads, where the task runs in the same thread with its own child conversation and queue, so the thread keeps answering while the task works. Replies are routed by Jev as in DMs, and task messages carry a label so they stand apart from the thread's conversation.

## Considered Options

- **Background child conversations (chosen):** hands lifetime, restart, and stop to pi-durable, writes the result back to the requester, and removes Slack's log-scanned status and the shutdown wait for tasks.
- **Keep thread sessions and re-queue unfinished task sessions at startup:** the smallest change, and it fixes the lost work. It keeps the inferred status, the 5-minute shutdown wait, and the requester's blindness to the result.
- **A pi-durable reporter task that drives the child** (example 23): the child's run would execute without a mikan session, so it would have no model binding, tool grant, budget, or presenter. mikan binds those per run, so the runtime drives the child instead.
- **Share the requester's session in a thread:** one conversation runs one thing at a time, so the thread would queue behind the task, which defeats the purpose of a task.
- **Foreground owned children ([ADR 0020](0020-subagents-as-owned-child-conversations.md)):** keeps the requester busy until the child answers.

## Consequences

- A deploy no longer waits for long tasks, and a task that outlives a restart finishes instead of being dropped.
- A tool call interrupted by a restart is not replayed; the model sees it as interrupted and may run it again. Startup ends the interrupted command's guest process group before any run resumes, so the rerun does not race the old copy.
- Each task costs one extra conversation record and one anchor task; its transcript was already stored as a thread session.
- Slack's log-scanned task status goes away with decision 8. `taskRoot` log entries stay readable for tasks started before the change, and still mark which DM threads are tasks.
- [ADR 0020](0020-subagents-as-owned-child-conversations.md) is rejected; subagents stay as they are.

## Resolved before acceptance

Measured on the implementation, against the same local daemon and test workspace.

| Question                                                       | Result                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A command keeps running in the container after the daemon dies | Startup kills every recorded guest process group before resuming (1.0.2). After `kill -9`, the old `sleep 120` was gone once the daemon restarted; the resumed task reran it and posted the output.                                        |
| A pending task run starts before its session is bound          | Reproduced in a test: a message to the requester after a restart drove the task's pending generation, which faulted with "Provider request has no active session binding". Decisions 5 and 6 abort it at open and resume with a new input. |
| Startup cost of finding task roots                             | Reading a 57 MB office log takes about 0.1 s. Only DM offices are read, and resume runs before backfill.                                                                                                                                   |
| The progress message posted before a crash stays at "…"        | It stays, and the notice "Restarted for an update; continuing this task." follows it in the thread, so the stale message reads as interrupted.                                                                                             |
| `SIGTERM` while a task runs a 300 s command                    | The daemon exited in 1 s; after the restart the task resumed.                                                                                                                                                                              |
| Requester asked for the result without tools                   | The DM answered with the task's output, read from the report written to its transcript.                                                                                                                                                    |

## Open questions

- In channels, who may steer or stop another person's task? Today only the requester's text steers.
