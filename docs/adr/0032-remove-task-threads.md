---
status: accepted
---

# Remove task threads

Slack task threads are removed: the `start_task` and `task_status` tools, the Jev classifier that sorted messages into status, steer, and request, its canned status replies, and steering a running turn. A conversation does long work in its own turn. This supersedes [ADR 0021](0021-tasks-as-background-child-conversations.md); nothing replaces it in this change.

## Context

ADR 0021 let the model hand long work to a new thread so the conversation kept answering, and answered "is it done?" without a model turn. [docs/research/task-threads-removal-2026-11.md](../research/task-threads-removal-2026-11.md) records what that cost and how it was used:

- In a deployment in use, the model hardly used it: `start_task` went uncalled over the period reviewed, and `task_status` was called rarely.
- It was three files of its own, branches in a dozen more, and the largest Slack test file. A thread reply read the office storage to learn whether it was a task control message before it was acknowledged.
- It judged messages for the model. Jev decided whether a message was a status question, a correction, or a new request, and a status question got a canned reply the model never saw.

The refactor scope planned to remove it together with a background-job tool ([background-jobs-2026-11.md](../research/background-jobs-2026-11.md)). The usage does not show a need that tool must cover on the same day, so the removal ships alone and the tool is decided separately.

## Decision

- Remove `start_task`, `task_status`, the task-intent classifier and its canned replies, the completion mention, the report of a task's answer to its requester, and the `steer` port on the handler, the runner, and the session.
- Every Slack message that triggers a run is an ordinary message of its session. A message sent while that session runs queues behind the run.
- Existing task threads stay as ordinary thread sessions. The session index already maps each thread to its conversation, so nothing is migrated. The `mikan.task-anchor` definition is no longer registered: a terminal anchor reads normally and a pending one stays pending.
- Runs still continue after a restart ([ADR 0027](0027-interrupted-runs-continue-after-restart.md)), a task thread that was running when the old process stopped included.

The paths that do the same job now:

| Need                                      | Path                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long multi-step work                      | The conversation does it in its own turn                                                                                                                                                                      |
| A slow command that should not block      | The model backgrounds it with the shell and checks on it later. Nothing tells it when the command ends, and the sandbox stops when idle ([background-jobs research](../research/background-jobs-2026-11.md)). |
| Work for later, or on a schedule          | The `event` tool                                                                                                                                                                                              |
| A large investigation kept out of context | The `subagent` tool ([ADR 0031](0031-a-minimal-subagent.md))                                                                                                                                                  |
| Stopping work                             | `stop`, as before                                                                                                                                                                                             |

## Considered Options

- **Remove it, add nothing (chosen):** the least code, and the usage does not justify more.
- **Remove it and add `bash_background` in the same change:** couples a removal that is ready to a design that is not yet decided.
- **Keep the tools and remove only the Jev classifier:** keeps the anchor task, the child conversation, the status reader, and most of the Slack branches for a tool the model hardly calls.

## Consequences

- Long work at the top level of a DM or channel keeps that session busy; the next message there is answered after it. Before, the conversation kept answering while the task ran. This regression is accepted.
- "Is it done?" is answered by the model, after the running turn when one is going. Before, it got a canned reply at once.
- A message sent while a turn runs can no longer be steered into it.
- After an upgrade, a reply in an existing task thread runs a normal turn there. A run that finishes in such a thread no longer mentions the requester and no longer writes its answer into the requester's transcript; answers written before the upgrade stay.
- A message that took the steer path last in an old task thread can appear once more as history when that thread is next used, because the marker that kept it out of chat-history sync is no longer read.
- A Slack thread reply costs one office-storage read less before it is acknowledged, and no Jev request is made for a DM message.
