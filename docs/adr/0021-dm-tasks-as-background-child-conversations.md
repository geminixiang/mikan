---
status: proposed
---

# DM tasks run as background child conversations

A DM task becomes a child conversation in the office Harness, owned by a background task of the conversation that started it. pi-durable then keeps the task's work across a restart, reports its result back to the requesting conversation, and stops it on request. Today mikan builds these pieces by hand in the Slack adapter, and a restart drops the work.

## Context

`start_task` is offered only in top-level Slack DMs. The Slack adapter posts an acknowledgement, records `taskRoot` on its office log entry, registers an empty thread session, and queues the task text on that session's Slack queue (`src/adapters/slack/bot.ts`). The task then runs as an ordinary ownerless session. `task_status` infers state from the office log's `taskRoot` entries and the runtime's running sessions (`src/adapters/slack/task-status.ts`). A reply in the task thread is classified by Jev and steered through the runtime steering port.

Because the task is an ordinary session, it shares the lifecycle of a foreground reply:

- **Shutdown waits for it.** `main.ts` drains conversation work for up to `SHUTDOWN_DRAIN_TIMEOUT_MS` (5 minutes) and then aborts it. Slack intake is stopped during the drain.
- **Opening the office aborts it.** `OfficeStorage.abortUnfinishedWork` aborts every unfinished task whose record has no owner task, so nothing resumes the work after a restart.
- **The requesting conversation never learns the result.** The task's answer stays in its thread; a later question in the DM can only read its execution status.
- **The task session is offered the task tools.** `getTaskStatus` is set for every direct conversation, task threads included.

pi-durable provides the pieces as public API (its README, "Abort and Subagents", and example `23-subagent-background.ts`). A task created with `{ background: true }` is a boundary: the requester's aborts and idle waits stop there. A conversation created with `ownership: { kind: "task", taskId }` starts as a copy of its owner conversation's agent. A background reporter task submits the work to that conversation, waits for the answer, and posts a report back; request IDs make each delivery happen once across a restart.

### Measurements

The restart rows ran against a local daemon on a test Slack workspace, with a real model, stopping the daemon with `SIGTERM` as a deploy does. The proof of concept ran outside `src/` on pi-durable 1.0.2 with the faux provider and node SQLite storage, so its times exclude model latency.

| Question                                              | Result                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart while a task runs a 150 s command             | Shutdown waited about 2 minutes for the task to finish, then exited. The answer arrived; Slack replies were stopped meanwhile.                                                                                               |
| Restart while a task runs a 420 s command             | Shutdown aborted the run after 5 minutes. The thread showed only a failed tool call; the interruption notice went to the DM's top level. After the restart nothing resumed, and `task_status` reported `aborted`.            |
| `start_task` called while the daemon is shutting down | The model answered that the task queue was closed.                                                                                                                                                                           |
| Task thread doing the wrong work                      | 1 of 3 task starts: the task session called `task_status` instead of running the command, replied that the task was still running, and the thread was then marked finished.                                                  |
| Today's open-time abort rule on a background task     | Aborted the reporter and the child's generation; the child never finished and the requester got no report.                                                                                                                   |
| Open-time abort skipping task-owned conversations     | Aborted nothing. The child resumed: the interrupted tool call came back as `interrupted`, the model ran it again, and the requester received `[task t1 done] …`. 0.34 s from reopen to settled, about 8 KB of extra storage. |

## Decision

1. **`start_task` creates the task in one commit on the requesting conversation**: a background anchor task, a child conversation owned by it, the child's session index record, and a background reporter task. The reporter submits the task text to the child with `requestId: task:<reporterId>` and, once the child settles, reports the outcome to the requesting conversation with `requestId: task-report:<reporterId>`.
2. **The report is a write, not an input**, so it adds the outcome to the requester's transcript without starting a model turn or posting another DM message. The adapter still tells the user in the task's thread.
3. **The child is configured without `start_task` and `task_status`**, and with its own mikan extension, in the creating commit.
4. **Opening office storage aborts unfinished work only in ownerless conversations**, and never background tasks. Task-owned conversations resume.
5. **The runtime resumes task conversations at startup.** After opening an office with live tasks in task-owned conversations, it opens a session for each one, as it does for an incoming message, so the conversation has its model binding, execution environment, and presenter.
6. **Shutdown stops waiting for task conversations.** The drain covers foreground runs only; task work stays pending and resumes after the restart.
7. **Status and stop come from pi-durable state.** `task_status` reads the requesting conversation's task document and each child's live run instead of the office log. Stop is `abort()` on the child. A steer in the task thread is a `whenBusy: "steer"` submission to the child; Jev classification is unchanged.
8. **The scope stays Slack top-level DMs.** The tool and its state are platform-neutral; another adapter needs only a place to show a task's output.

## Considered Options

- **Background child conversations (chosen):** hands lifetime, restart, report delivery, and stop to pi-durable through its documented API, and removes Slack's queue admission, log-scanned status, and shutdown wait for tasks. It needs the startup resume in decision 5.
- **Keep thread sessions and re-queue unfinished task sessions at startup:** the smallest change, and it fixes the lost work. It keeps the Slack-only queue path, the inferred status, the 5-minute shutdown wait, and the requester's blindness to the result.
- **Foreground owned children ([ADR 0020](0020-subagents-as-owned-child-conversations.md)):** keeps the requester busy until the child answers, which defeats a task's purpose of letting the user keep talking.

## Consequences

- A deploy no longer waits for long tasks, and a task that outlives a restart finishes instead of being dropped.
- A tool call interrupted by the restart is not replayed; the model sees it as interrupted and may run it again, so a non-idempotent command can run twice.
- Each task costs one extra conversation record and two small tasks, about 8 KB in the proof of concept; its transcript was already stored as a thread session.
- Slack's `startTask` queue path, `readTaskRoots`, and the inference in `querySlackTasks` are removed. `taskRoot` log entries stay readable for tasks started before the change.
- [ADR 0020](0020-subagents-as-owned-child-conversations.md) is rejected; subagents stay as they are.

## Open questions before acceptance

- How does decision 5 bind a resumed conversation's model and budget? `OfficeStorage` routes provider requests to a bound session by provider session ID, and a resumed task has no bound session until one is opened.
- Does a write entry reach the requester's model context on its next turn, and in what role? `SessionStore.appendMessage` is the existing path for host-written user messages.
- Can the Slack presenter attach to a resumed child's events so the thread shows progress again?
- Does a command inside the sandbox keep running after the daemon exits, and does the rerun in that case collide with it?
- Do memory capture and the usage summary run once per task, as they do for a thread session today?
