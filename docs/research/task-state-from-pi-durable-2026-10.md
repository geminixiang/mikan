# Reading task state from pi-durable (2026-10)

Question: [ADR 0021](../adr/0021-tasks-as-background-child-conversations.md) decision 8 says task status and stop should come from pi-durable state instead of the office log. What does pi-durable 1.1.0 offer for that, what does mikan already use, and what is missing?

Sources: the pi-durable 1.1.0 README and type declarations, its example `23-subagent-background.ts` at the 1.1.0 release commit, `src/sessions/session-store.ts`, `src/harness/session.ts`, and [Who owns what between the platform adapters and the core](adapter-responsibilities-2026-10.md). Experiments are under `.workspace/task-owner/`, on pi-durable's public API, either in memory with the faux provider or on a `sqlite3 .backup` copy of a local test DM office.

## What pi-durable offers

| Need                             | pi-durable API                                                                  | Notes                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| List a requester's tasks         | `tx.scanConversations({ ownerConversationId }, limit, cursor)`                  | Ordered scan over the ownership index; `order: "descending"` gives newest first                                       |
| Is this conversation a task      | `ConversationRecord.owner` (`tx.conversation(id)` or the view's `conversation`) | Owner edge `{ conversationId, taskId }`; survives after the owner task ends                                           |
| What the task was asked          | `TaskRecord.input` of the owner task (`tx.task(id)`)                            | "Original task input retained while the task is live or terminal"                                                     |
| Is it running                    | `LiveDoc.run`                                                                   | "Present exactly while busy"; `LiveDoc.tools` lists the current round's tool names and status, not their arguments    |
| Stop it                          | `conversation.abort()` on the child                                             | Withdraws its queued input and aborts its current work; the conversation stays usable                                 |
| Steer it                         | `submit({ type: "input", whenBusy: "steer" })` on the child                     | Placed after the current tool round                                                                                   |
| Keep it apart from the requester | Owner task created with `background: true`                                      | The requester's `abort()` and idle waits stop at the boundary; `abort(context, { background: true })` reaches past it |
| Task graph                       | `harness.taskGraph()`                                                           | Lists live tasks only                                                                                                 |

Example 23 builds persistent background subagents from exactly these pieces: a background anchor task owns each child, `LiveDoc.run` answers "working or idle", `abort()` stops one, and a steer or follow-up submission messages one.

## What mikan already uses

| Piece                               | Where                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Background anchor and owned child   | `createTaskSession` in `session-store.ts`                                                |
| Stop through `conversation.abort()` | `HarnessSession.abort` in `harness/session.ts`, reached from the runtime's running state |
| Steer through a `steer` submission  | `HarnessSession.steer`, reached from `handler.steer`                                     |
| Result written to the requester     | `SessionStore.reportTaskOutcome`                                                         |
| Run start and end                   | mikan's own `mikan.session` document (`run`)                                             |

So stop and steer already act on the child through pi-durable. What does not come from pi-durable is the list of tasks, their acknowledgement text, and whether a thread is a task: all three come from `taskRoot` entries in `log.jsonl`.

## Experiments

| Question                                              | Result                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `LiveDoc.run` track a running task?              | In memory, two tasks streaming a slow faux answer: both `busy` while running, both idle once settled                                                                                                                                            |
| Does stopping the requester reach its tasks?          | `root.abort()` ended the requester's own run (`unanswered`) and left both tasks running                                                                                                                                                         |
| Does stopping one task leave the others?              | `A.abort()` settled A as `unanswered`, reason `aborted`; B kept running and finished                                                                                                                                                            |
| Does a steer reach a running task?                    | A `steer` submission to B settled `done` together with B's run                                                                                                                                                                                  |
| Can the task's brief or acknowledgement be read back? | Stored as the anchor's input, yes. From the transcript, no: in the local copy, the first `pi.user` entry of 2 of 10 tasks is the resume prompt and the rest carry chat-history prefixes, because mikan records chat messages as its own entries |
| Cost of listing a DM's tasks from pi-durable          | 10 tasks with key, busy, and ended status: 7.1 ms on first open, 1.5 ms warm. The log scan it replaces costs 2.3 ms per 0.7 MB of log and grows with the log                                                                                    |

## What decision 8 would change

- **List**: one `SessionStore` read lists a requester's tasks by owner, with each task's session key from the session index, busy from `LiveDoc.run`, and the last result from `mikan.session`. It replaces `readTaskRoots`, the runtime join, and `inspectExecution` in `querySlackTasks`.
- **Is a task**: the session's conversation has an owner. It replaces the log scan in `isTaskThread` and `hasRunningTaskThread`, and gives the restart resume its list of candidates.
- **Acknowledgement**: stored as the anchor task's input when the task is created, so the task record carries it.

## Decisions

| Decision                        | Outcome                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Where the acknowledgement lives | The anchor task's input                                                                                                        |
| Tasks created before the change | Accepted: 1.0.x task threads are no longer recognized; tasks from 1.1.0 to 1.2.2 list without an acknowledgement               |
| Current step                    | Kept from the runtime                                                                                                          |
| Who calls it                    | Slack still calls `SessionStore`; exposing the list through the runtime is left for the move of tasks out of the Slack adapter |

Shipped in [#160](https://github.com/geminixiang/mikan/pull/160). Its acceptance eval, run on `main` and on the branch:

| Case                                              | `main`                                  | Branch                                       |
| ------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| Three tasks (completed, stopped, running)         | 3/3                                     | 3/3                                          |
| After a restart                                   | 3/3                                     | 3/3                                          |
| Status question in a task thread                  | Answered without a model call           | Same                                         |
| After the office log is lost                      | 0/3; the thread reply goes to the model | 3/3; answered without a model call           |
| Task thread from 1.0.x                            | Recognized                              | Not recognized (accepted)                    |
| Thread status reply with a 50 MB log, median of 5 | 505 ms                                  | 142 ms                                       |
| Tasks written by `main`, read by the branch       | Found, status correct, acknowledgement  | Found, status correct, empty acknowledgement |
