---
status: accepted
---

# Background shell jobs

mikan offers a `bash_background` tool: the model starts a long shell command, gets a job ID at once, and keeps talking. When the job exits, mikan tells the session that started it the exit code and where the output is, and gives the agent a turn. This fills the gap [ADR 0032](0032-remove-task-threads.md) left when it removed task threads without a replacement.

## Context

After ADR 0032 a slow command either keeps its session busy or is backgrounded by the shell, where nothing tells the model that it ended and the sandbox's idle stop kills it without a word. The owner asked for the core of [pi-bg-bash](https://github.com/geminixiang/pi-stuff/tree/main/packages/pi-bg-bash): start, get an ID, be told at exit. That package cannot be used as it is, because it spawns on the host and is built on another Pi runtime; mikan's commands run in a per-office container.

[docs/research/background-jobs-2026-11.md](../research/background-jobs-2026-11.md) has the reference designs, the experiments, the candidates, and the acceptance eval. What they established:

- A command started under `setsid` outlives the call that started it, the pi-env daemon, and a mikan restart. It does not outlive its container.
- The office directory is a bind mount, so a file the job writes is a host file. The guest can also replace any file there with a link that resolves on the host.
- With the command in a process group of its own under a wrapper, killing that group leaves the wrapper to write the exit code.
- Every adapter's `enqueueEvent` could already run an event in a session it names, except Slack's for a session without a thread.

## Decision

- **Tool.** `bash_background { label, command }` (`src/harness/tools/bash-background.ts`) starts a wrapper through the session's execution environment and returns the job ID and the guest paths of the job's files in `<office>/.jobs/<id>/`: `log` (stdout and stderr), `pid` (the command's process group, written by the job itself once it has that group), and `exit` (the exit code, written last through a rename). Reading output, listing jobs, and killing are done by the model with `bash`; there are no tools for them. The call is replay-safe: the ID comes from a task memo, and a start whose directory exists starts nothing.
- **Records.** Before starting, the tool registers the job with the watcher, which keeps one private file per office in its state directory (`jobs.json`): ID, command, label, the owning session key with its thread, user and conversation kind, the guest path, start time, how it ended, and whether the notice was delivered. Routing uses only this record, never a file the guest can write.
- **Watcher.** One host-side component (`src/events/jobs.ts`) polls the jobs that have no delivered notice once a second. It reads only `exit` from the host path of the office directory, through directories opened without following links and a file opened with `O_NOFOLLOW`, and accepts at most 16 bytes holding a number from 0 to 255. It never reads `log`.
- **Notice.** Two lines: `[job <id> exited <code> after <duration>] <command>` and `Its output is in <guest dir>/log; read it with bash.` It carries none of the job's output: a tail would reach the model without the secret redaction every tool result gets, while the `bash` call that reads the log is redacted. It is delivered as an injected event that names the owning session (`MessagingBot.enqueueEvent`, event ID `job:<id>`), so the model receives it as input and answers where that session answers. A busy session runs it after its current turn. A notice the platform does not accept is offered again on the next poll.
- **One seam for every platform.** An injected event that carries a `sessionKey` runs in that session. Telegram and GitHub already did this. Slack now skips the anchor message for such an event, offers it to that session's queue, and answers in the thread the session key names; Discord no longer treats a job notice ID as a message to reply to; no platform reacts to one. Scheduled events carry no session and behave as before.
- **Limit.** A job runs for at most 2 hours. At the limit the watcher kills the job's process group inside the container and delivers a notice that the job ended without an exit code.
- **Idle stop.** While a job runs, the watcher retains the office's container, as a connected desktop viewer does.
- **Restart.** At startup the watcher reads every office's records and retains containers with running jobs before the first idle check, and delivers undelivered notices once the platform bots have started.
- **`stop` and `/new`** do not kill jobs. A notice for a job started before `/new` arrives in the new context of the same session key.
- **Prompt.** One line in the tool list. The tool's description states the limits.

## Options considered

| Option                                                            | Why not                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C0: teach `setsid cmd >log 2>&1 &` in the prompt                  | The model never learns that the job ended, and the idle stop kills it silently.                                                                                  |
| C2: replace Pi's `bash` with one that promotes every slow command | Replaces a foundation's tool and its output rules with about 300 lines of mikan's own.                                                                           |
| C3: a pi-durable task per job that sleeps and checks              | A commit per check, and sleeping tasks resume only while the office storage is open, so a startup scan is needed anyway.                                         |
| Report a job as lost when its container's start time changes      | An engine call per running job per poll, for a case the 2-hour limit already bounds. Left out by the owner's decision.                                           |
| A Slack-only delivery path, as task threads had                   | The event seam already existed on every platform; a Slack capability would have needed a second seam and left three platforms without the tool.                  |
| Put the last lines of the log in the notice, as pi-bg-bash does   | The notice is model input, not a tool result, so the tail would skip secret redaction, and the host would have to read a file the guest can replace with a link. |
| Separate tools to read output, list, and kill                     | `bash` on the job's files does all three; more tools are more schema in every request.                                                                           |
| Steer the notice into a running turn                              | A steer admitted after the turn answered starts a run mikan does not present. The notice queues instead.                                                         |
| Remove a job's directory after a week                             | The host would delete inside a tree the guest can fill with links. The host record is dropped after a week; the directory is the model's to remove.              |

## Consequences

- The agent can start a build or a test run, answer other messages, and report the result when it arrives, on every platform.
- A job whose container is stopped or replaced under it (an operator's `stop`, a crash, an image update after a stop) is reported at the 2-hour limit, not when it dies. Until then the model sees a log that stopped growing and no exit file.
- A container with a running job is not idle-stopped for up to 2 hours.
- A notice queued behind a turn and not yet started when mikan stops is lost, as a queued message is. A crash between a platform accepting a notice and the record being marked delivers it twice.
- Seeing a job's output costs the model one more tool call after the notice. In exchange the output passes through the same secret redaction as any `bash` result, nothing a command printed arrives as input in the name of the user who started the job, and the host never opens the guest-written `log`.
- Job directories accumulate under `<office>/.jobs/` until the model or a person removes them.
- Slack events that name a session skip the conversation's queue and wait only for their own session. No current caller other than the watcher sends such an event.
- About 480 lines of production code and one more tool schema in every request.

## Removal condition

Checked on 2027-02-22 from production tool counts: if `bash_background` was called fewer than 20 times in the previous 30 days, remove the tool and the watcher. The remaining path is the shell's own backgrounding (`setsid cmd >log 2>&1 &`), with no notice and no protection from the idle stop. The rule that a session-naming event runs in its session stays, because it is the contract of `enqueueEvent`, not part of this feature.
