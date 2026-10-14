---
status: accepted
---

# Runs interrupted by a restart continue in pi-durable

When mikan restarts while an agent run is going, pi-durable continues that run where it stopped, as Pi's own hosts do. mikan no longer aborts the interrupted work of a platform that continues it: it binds each interrupted session and then calls `harness.resume()`. This replaces the abort-and-resume-prompt flow of [ADR 0021](0021-tasks-as-background-child-conversations.md) decisions 5 to 7 and extends continuation from tasks to every Slack run.

## Context

Runs are getting longer: the planned GitHub agent ([research](../research/github-one-agent-2026-10.md)) and long tasks may run for hours, so a deploy or a crash during one is likely.

pi-durable already keeps such work (`@earendil-works/pi-durable` 1.2 README, "Persist and Resume"; `docs/spec.md` on `close()`): work interrupted by a crash or by `close()` stays pending, `close()` writes no task outcome, and `harness.resume()` continues it. A tool call cut off mid-run reruns only when the tool is `replay: "safe"`; otherwise the model gets "Tool X was interrupted and may have partially run". A crash and a close are treated alike, and nothing limits how often work resumes. Pi's coding agent calls `harness.resume()` when it opens a session.

mikan turned this off. ADR 0017 aborted unfinished runs before the next prompt, without a recorded reason. One storage per office then made it necessary: the first submission to any conversation starts the scheduler for all of them, and a pending generation of a conversation mikan has not bound fails without an answer or an error. ADR 0021 kept the abort for tasks and restarted them as a new run with a resume prompt, after a prototype in which native continuation without a prompt gave up. Shutdown waited up to 5 minutes for foreground runs and then aborted them. No production restart from 2026-10-01 to 10-13 interrupted a run, because deploys waited for an idle daemon; that stops holding once runs last hours.

### Measurements

pi-durable 1.2, real model, a shell tool that streams its output, the run asking for `sleep 20; date +%s`, the process stopped 2 s into the command and reopened; 5 trials per cell:

| Stop      | Continuation on reopen                           | Answered        | Tokens after reopen |
| --------- | ------------------------------------------------ | --------------- | ------------------- |
| `SIGKILL` | Native, nothing added                            | 0/5             | 475                 |
| `SIGKILL` | Native, one standing line in the instructions    | 5/5             | 1,063               |
| `SIGKILL` | Native, a steer message                          | 5/5             | 1,071               |
| `SIGKILL` | Abort, new run with the resume prompt (ADR 0021) | 5/5             | 1,066               |
| `close()` | The same four                                    | 0, 5, 5, 5 of 5 | as above            |

The earlier finding that native continuation costs more tokens did not hold, and a standing instruction replaces the per-resume prompt; with a steer the model sometimes reran only part of the command.

A prototype inside mikan on a local Slack workspace, killing the daemon during `sleep 90; date +%s`: a channel thread continued and answered; a thread interrupted twice continued after each restart; two threads interrupted in one office both continued once both were bound; `SIGTERM` exited in about 1 s instead of waiting for the run, and the run continued after the restart. Startup took 0.1–0.6 s more for 11 channels. A top-level DM was not measured, because the model hands such a request to `start_task`.

## Decision

1. **The system prompt says what an interrupted tool means**: check what it already did, rerun it if that is safe, and finish.
2. **A platform declares that it continues interrupted runs** (`MessagingInfo.continuesInterruptedRuns`). Shutdown neither waits for nor aborts its runs. Slack declares it; other platforms keep the 5-minute drain and the abort.
3. **Startup continues instead of aborting.** Before its socket connects, the Slack bot calls `SessionStore.continueInterrupted` for each channel. For an office whose storage changed in the last 24 hours, that opens the storage without aborting, keeps the interrupted runs of sessions in its index, aborts the rest, and returns the kept session keys. The bot posts "Restarted for an update; continuing." where each one replies and queues a run that continues the pending turn instead of submitting input (`continuedRunId`).
4. **Nothing runs before every kept session is bound.** The storage stays open until every kept session's run has bound; then it calls `harness.resume()`. Every other submission in that office waits until then. A session still unbound after 60 seconds is aborted, so it cannot fail silently, and the rest continue.
5. **Tasks continue the same way**, keeping their completion mention and their report to the requester; the resume prompt and the two-resume cap are gone. A continued run is offered neither `start_task` nor `task_status`.

## Considered Options

- **Native continuation (chosen):** pi-durable owns the work's lifetime, as in Pi; mikan only binds and orders.
- **Abort and start a new run with a resume prompt, for every session:** worked in a prototype and costs the same, but keeps mikan's own copy of resume, its prompt, and its own limit.
- **Only the abort-on-open removal, binding as messages arrive:** a message to one session would start the scheduler before the others are bound, and they fail silently.
- **Leave non-task runs as they are:** every deploy drops long runs.

## Consequences

- A deploy no longer waits for Slack runs, and a Slack run continues after it.
- A step may run twice when its tool is not replay-safe; the model sees that it was interrupted.
- A run whose step crashes the daemon crashes it again after each restart, as in Pi; the process manager's restart backoff bounds it.
- A message queued behind a run but not yet started when the process stops is lost, as before.
- Offices idle for more than 24 hours, and offices of platforms that do not continue, still abort interrupted work when they are next opened.
- A scheduled event or a message that opens an office before the startup scan reaches it aborts that office's interrupted runs; the scan runs before the socket connects to keep that window short.
