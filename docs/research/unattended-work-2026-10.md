# Unattended work: how Cursor and pstack keep agents running (research, 2026-10)

Question: what mechanism lets a mikan agent keep working while nobody watches, wait for an event or a decision, and resume, without the user re-prompting it? This file records what Cursor ships and what one of its engineers' skill packs (pstack) prescribes, and maps both onto mikan and pi-durable. No code changed.

Sources, read 2026-10-08:

- Cursor docs: [Cloud agent capabilities, Subscriptions](https://cursor.com/docs/cloud-agent/capabilities.md), [Automations](https://cursor.com/docs/cloud-agent/automations.md).
- [cursor/plugins](https://github.com/cursor/plugins) at `ccb5507c`: `pstack` (guide chapter 07, `poteto-mode` playbooks `autonomous-run`, `pause-safely`, `session-pickup`, `orchestrate`, `babysit`, skills `show-me-your-work`, `figure-it-out`, the principle skills, the `benny` automation pack), the `orchestrate` plugin (`references/planner.md`, `references/handoffs.md`, `prompts/loop-hygiene.md`, `schemas/state.schema.json`), `ralph-loop`, `continual-learning`.
- pi-durable 1.1.0: `README.md` sections Child Tasks, Your Own State, Abort and Subagents; `dist/types.d.ts` (`TaskState`, `TaskRuntime.sleep`).

## Two layers

Cursor splits the problem in two. The product supplies triggers and wake-ups; the skills supply the discipline that makes an unattended run trustworthy.

### Product: triggers and subscriptions

| Mechanism     | What it does                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automations   | Start a new cloud agent on a schedule (cron, may run late, never early) or an event: PR opened or pushed, Slack message or emoji reaction, webhook, Linear, Sentry, PagerDuty. Per-automation tools, model, and identity.                |
| Memories      | Per-automation notes (`MEMORIES.md`) kept outside the agent's filesystem across runs. The docs warn that untrusted input can plant misleading memories.                                                                                  |
| Subscriptions | A running agent subscribes to an event source, ends its turn, and **wakes as a follow-up in the same conversation** when the event arrives: one PR's activity, CI on a branch, a Slack thread reply or channel message, Linear, a timer. |

Subscription rules worth copying:

- A subscription belongs to one conversation.
- Bursts coalesce into one wake, and the agent re-reads the source (PR, thread, issue) before acting instead of trusting the event payload.
- A subscription lasts at most 180 days; the agent unsubscribes when the wait is over.
- CI delivers one commit-wide result once every check completes. A check that waits for a person should finish as `action_required` so the wait does not hang.
- The recurring `/loop` skill is a timer subscription.

### Skills: what makes a run trustworthy

| Rule                                        | Where                                     | Content                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earn trust before the loop                  | guide 07, pitfalls                        | Loop only after the task was done once under watch, the agent has the verification tools, every stage can stop the line, and repeated failures became checks. "A loop that can't verify its own work only makes unchecked work faster." |
| The handoff contract                        | guide 07                                  | Goal, a **checkable finish condition**, pre-answered permissions, and an escape hatch ("if truly stuck after a few hours, stop and write up why"). A duration is not a finish condition.                                                |
| Wake on events, heartbeat as fallback       | `autonomous-run`                          | Watch the event (CI, merge, ref) and keep a long timer as a fallback; with no event, a fixed heartbeat sized to when the result is worth re-checking. Never a second sleep loop.                                                        |
| One change, one check, one log row          | guide 07, `autonomous-run`                | Each iteration makes the smallest justified change, verifies it, keeps or discards it, and logs a row. A plateau means pivot; the predicate never relaxes.                                                                              |
| Decision trail                              | `show-me-your-work`                       | Append-only TSV: `ts, phase, decision, why, evidence, result`. Evidence is a pointer (commit, file:line, artifact), never prose. A wrong row is superseded, never edited. A new run marks its first row `start`.                        |
| Morning audit                               | guide 07, `show-me-your-work`             | The reply ends with an **Attention** section written by a reviewer on a different model family, pointing at rows that deserve scrutiny. The human audits decisions, not the whole night.                                                |
| Escalate narrowly, never block              | `never-block-on-the-human`, `orchestrate` | Only irreversible actions, product or preference calls no experiment settles, and real dead ends reach the human. Each is parked as a gate (question, options, **default on no answer**) and work routes around it.                     |
| Pause and pickup                            | `pause-safely`, `session-pickup`          | Pausing is explicit only; it stops at a safe boundary, commits a `wip:` checkpoint, and writes a resume note. A pickup treats the prior trail as authoritative and redoes nothing.                                                      |
| State lives outside the agent               | `orchestrate` plugin                      | "Long-running agent loops drift; a script with a JSON state file keeps its footing." `plan.json`, `state.json`, `handoffs/*.md`, `attention.log` on disk and git. Slack is visibility, not state.                                       |
| Structured handoff per unit                 | `handoffs.md`                             | Every unit ends with status, branch, what it did, notes, follow-ups. A unit that dies silently gets a **synthetic failure handoff** written by the script, so the planner sees a postmortem instead of silence.                         |
| Failure taxonomy and retry cap              | `handoffs.md`, `loop-hygiene.md`          | `cap-hit`/`oom` retry smaller, `network-drop` retry as is, `tool-error` retry on another model, `unknown` retry once. `maxAttempts` caps respawns; after two retries, abandon and replan.                                               |
| Mechanism owns liveness, agent owns meaning | `planner.md`, `orchestrate` playbook      | A restarted loop reattaches running work (`recoverRunning`). Never resume an agent only to check on it; probe its state read-only.                                                                                                      |
| Andon                                       | `orchestrate` plugin                      | A `:rotating_light:` reaction on the kickoff message halts new work across the tree, with a required reason. A single task's snag is a blocked handoff, not an Andon.                                                                   |
| Stay in the thread                          | `benny`, `orchestrate`                    | Automations reply only in the source thread, never post a root message, write like a human, and stay quiet unless silence would hide something. Missing configuration fails closed.                                                     |
| Budgets per stage                           | `benny` configuration                     | Minutes per stage (triage 30, repro 60, fix 90), poll interval, verdict wait, and status emoji per state (seen, reproducing, blocked, fixing, PR opened).                                                                               |

`ralph-loop` is the minimal form: resubmit the same prompt after every turn until the reply contains a completion phrase or `--max-iterations` is reached. `continual-learning` refreshes `AGENTS.md` from transcripts on a cadence (at least 10 turns and 120 minutes), the same idea as mikan's memory capture (ADR 0011).

## Mapping onto mikan

| Cursor concept                           | mikan today                                                                                                 | pi-durable primitive (read, not yet tried)                                                                                                                                             | Gap                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Scheduled trigger                        | `event` tool: `immediate`, `one-shot`, `periodic` (`src/events/`). Runs in the channel's top-level session. | —                                                                                                                                                                                      | An event cannot target a thread or task session.                                 |
| Event trigger                            | Slack mentions and DMs; GitHub webhooks (adapter being redesigned).                                         | —                                                                                                                                                                                      | No emoji-reaction trigger.                                                       |
| Subscription: wake the same conversation | None. A thread reply starts a run in the thread's session, which is the closest behavior.                   | `submit()` queues a follow-up in a conversation's inbox; background tasks; `waiting` tasks parked on other tasks; `TaskRuntime.sleep(until)`; the reporter-task pattern of example 23. | Routing an external event or a timer to one task session, with burst coalescing. |
| Handoff / outcome                        | A finished DM task writes its answer to the requester's DM transcript (1.1.0).                              | Task outcomes; `defineDoc` documents committed with entries.                                                                                                                           | No structured status (done, blocked, failed) or follow-ups.                      |
| State outside the agent                  | Task roots in `log.jsonl`; run start and end in the session document.                                       | `defineDoc` with conversation scope.                                                                                                                                                   | No per-task record with state, attempts, and gates.                              |
| Decision trail                           | Transcript only.                                                                                            | A document or entries.                                                                                                                                                                 | No append-only, evidence-pointing log.                                           |
| Gates with defaults                      | None. Block Kit actions arrive as `[Slack action] <id>: <value>` in the session that posted them.           | —                                                                                                                                                                                      | Gate record, button rendering, routing the answer back to the waiting task.      |
| Morning report                           | None.                                                                                                       | —                                                                                                                                                                                      | A view derived from task records.                                                |
| Quiet when nothing happened              | `[SILENT]` for periodic events.                                                                             | —                                                                                                                                                                                      | Already covered.                                                                 |
| Budgets                                  | `DEFAULT_EVENT_BUDGET` (10 min, 50 calls, $10) for event runs only; other runs unlimited by default.        | Usage documents.                                                                                                                                                                       | Task budgets.                                                                    |
| Retry cap on restart                     | 1.1.0 resumes a DM task whose run started in the last 24 hours and never ended, on every start.             | —                                                                                                                                                                                      | No attempt count (see below).                                                    |
| Andon / stop                             | Stop command and button per run.                                                                            | `abort`, including `{ background: true }`.                                                                                                                                             | No stop-everything signal.                                                       |
| Memory across runs                       | Office `MEMORY.md` and memory capture.                                                                      | —                                                                                                                                                                                      | Covered; same untrusted-input caveat.                                            |

## Finding: the 1.1.0 resume has no attempt cap

Read from code, not reproduced. `resumeInterruptedTasks` (`src/adapters/slack/bot.ts`) resumes every DM task whose run recorded a start in the last 24 hours and no end, and submits without a request ID. If the resumed run kills the daemon again (an out-of-memory command, for example), the next start resumes it again, and a process manager that restarts at once turns this into a crash loop for up to 24 hours. Cursor's orchestrate caps respawns (`maxAttempts`, abandon after two retries) and writes a failure handoff instead of retrying silently. A cap of one or two resumes per task, with a notice in the task thread when the cap is reached, closes this.

## Candidate mechanism for mikan

A sketch to test, ordered so each step stands alone. Every step needs the usual research, POC, and measurement before code.

1. **Resume cap and failure notice.** Count resumes per task; past the cap, post why in the task thread and stop. Fixes the finding above.
2. **Task contract.** `start_task` accepts a finish condition and a stop rule (time or budget) next to the message, and the task prompt states them. Unattended runs get a default budget like event runs.
3. **Task record.** One document per task conversation, written by mikan, not the model: state (`running`, `waiting`, `done`, `failed`, `abandoned`), attempts, failure mode, outcome summary, open gates. Status and reports are derived from it.
4. **Wake into the same task.** A subscription names a source (thread reply, button, timer, later a GitHub PR or CI) and submits a follow-up to the task's conversation when it fires; bursts coalesce and the agent re-reads the source.
5. **Gates.** The agent parks a decision as question, options, and a default with a deadline, keeps working around it, and the button answer wakes the task. No answer by the deadline applies the default.
6. **Report.** A scheduled summary, derived from task records, posted in the DM: open gates first, then failed, then done, quiet when there is nothing.

## Open questions

- Whether a pi-durable `waiting` task, a background anchor, or a plain follow-up submission is the right carrier for a subscription across restarts. Needs a POC.
- Whether a gate belongs in the task record document or in entries of the task conversation.
- Cost of a periodic report run versus a report rendered without a model.

## Goal stated by the user: find patterns, report, run a workflow

The target is an agent that finds regularities in memory and history, reports them unprompted, designs a reasonably efficient workflow for one, and carries it to completion. Evidence that shapes the design:

- Proactive suggestions misfire often. On the ICLR 2025 Proactive Agent benchmark, GPT-4o had 98.1% recall and a 51.9% false-alarm rate ([paper](https://proceedings.iclr.cc/paper_files/paper/2025/file/75c37811e830bf029584b1c6fac17726-Paper-Conference.pdf)). In a CHI 2025 coding study, 53.3% of 398 interventions were engaged, 12.1% judged disruptive, 34.7% ignored. Two 2026 vignette studies (N=761, N=571) found unsolicited help lowered willingness to accept it, and asking first did not remove that cost.
- ChatGPT Pulse, a daily briefing from memory and chats, was folded into scheduled tasks in June 2026. OpenAI gave no usage reason.
- OpenClaw's heartbeat is deliberately conservative: it does not invent recurring tasks from prior chats and replies `NO_REPLY` when nothing needs attention.
- mikan's own Dream (ADR 0012) read session history nightly and was removed: 83% of entries were never read, one attempt in five failed, and rewrites came from stale evidence. A pattern miner must read incrementally, cite evidence, and never rewrite memory.

Implications:

1. **Report with evidence, ask once, then run.** A finding cites the messages it came from (dates, counts). The first report proposes a workflow; only after the user accepts does it become a standing workflow with a contract (trigger, finish condition, budget). Later runs need no approval. This is pstack's trust ladder.
2. **Measure precision.** Record every proposal and whether it was accepted, dismissed, or ignored. Raise the bar when dismissals grow; stay quiet by default.
3. **Report at a boundary, not mid-work**: in a scheduled digest, not interrupting a running conversation.
4. **Candidate signals** to test on real logs before any code: the same kind of request repeated at a regular interval, the same manual multi-step sequence repeated, promises left open ("I'll check tomorrow"), and the same failure recurring.

## POC: mining one production channel (2026-10-08)

A read-only copy of one busy shared channel office: `log.jsonl` (13,211 records, March to October), `sessions.db` (175 conversations, 17,757 entries, May to October), `MEMORY.md`, and its events. Scripts ran outside the repository; the copy stays in a private temporary directory.

### Pitfalls found while extracting requests

- Chat history sync writes other people's and other bots' messages into sessions as user and assistant entries. Pairing a user entry with the next assistant entry counted 1,357 "requests"; only assistant entries whose provider is not `platform-history` are real runs.
- Real run inputs start with the `## Attribution` block, and event runs with `## Event Trigger Mode`, before the `[date] [user]` line.
- Most channel traffic is people talking to each other (3,148 standup posts from 28 authors, another bot's reports). Human requests to the agent: 242 from 9 people, one person sending 79%.

### What the data shows

| Pattern                             | Evidence                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Metric lookups dominate             | 130 of 242 requests ask for one metric (revenue, RPM, IVT, traffic) of one publisher or account over a window. Median 3 tool calls, 77 s, $0.67; $120.75 in total. The agent re-read the same data skill in 116 of these runs. |
| A periodic report is mostly silence | One periodic event (every two hours) ran 112 times; 95 runs ended `[SILENT]` and cost $38.33 of $47.19, with a median of 9 tool calls to decide there was nothing new.                                                         |
| Follow-up issues requested by hand  | 7 requests on 7 days to file a follow-up issue and assign people.                                                                                                                                                              |
| Long-open items                     | Standup items open 20 to 60 days without being struck through; another bot already posts open follow-ups daily.                                                                                                                |
| Explicit recurring asks             | Requests such as "track this agency every day" already became events; no unscheduled recurring ask was found.                                                                                                                  |

### Can the model find and design the workflow itself?

Two model passes on `gpt-6-luna`: classify each request (intent, entity, metric, window, kind), then propose at most three workflows from the classified list and the run statistics.

- Classification worked: kinds were sensible (130 data queries, 40 analyses, 20 actions, 25 questions, 25 follow-ups), but free-form intent names fragmented one job into many labels, so counting needs a fixed vocabulary.
- The proposals were plausible but weak. It proposed a "standard query template" with an invented 20 to 30% saving, and a generic analysis checklist. It **rejected the largest measured saving**, the silent periodic runs, calling it a duplicate of the existing event, and dismissed the repeated skill reads for lacking a cost split that the statistics it was given already implied.

### Conclusions for the mechanism

1. Compute evidence deterministically (counts, dates, cost, tool calls, silent ratio) and give it to the model; let the model name and phrase the pattern, never invent numbers.
2. Efficiency patterns in mikan's own runs are the most reliable first source: the data is complete and the saving is measurable. Here: a script-only pre-check before a periodic run (Hermes' no-agent cron) would have avoided most of $38.33, and a saved query per metric would shorten 130 lookups.
3. User-behavior patterns are thinner than expected: one channel had 242 requests in five months, mostly from one person. A useful report likely needs several offices or a longer window.
4. A second judge, or a fixed rubric, should check proposals before they reach the user, because the proposer missed the best one.

### Jev as the judge

mikan already uses Jev (`src/harness/jev.ts`, `~typesafe/jev-latest` through OpenRouter) for the memory capture gate, the auto-reply gate, and task intent. Two tests on the same data:

- **Fixed-vocabulary classification.** One `choice` question with eight jobs per request: 242 requests for $0.0056 in 296 s at concurrency 6 (p50 0.6 s, p90 5.9 s; an earlier run hit HTTP 529 and 503 from an overloaded backend, and single calls took 10 to 27 s). It agreed with the chat model's coarse kinds (data queries became metric lookups or lists, actions became issues or tasks) and split them into countable jobs: 100 metric lookups, 46 lists or rankings, 18 trend analyses, 17 issues or tasks. 49 answers had confidence below 0.6.
- **Judging proposals.** Six proposals against the same measured facts: the chat model's two, the two measured savings it missed, and two decoys. Questions: evidence strength (score 0 to 3), measurable without invented percentages, duplicate of an existing bot or event, and whether to propose now.

| Proposal                                   | Evidence | Measurable | Duplicate | Propose |
| ------------------------------------------ | -------- | ---------- | --------- | ------- |
| Script pre-check before periodic runs      | 2.94     | 0.80       | 0.26      | 0.79    |
| Saved query scripts for metric lookups     | 2.54     | 0.56       | 0.19      | 0.65    |
| Query templates, "saves 20 to 30%"         | 1.66     | 0.27       | 0.28      | 0.62    |
| Analysis checklist                         | 1.42     | 0.36       | 0.22      | 0.50    |
| Daily standup digest (another bot does it) | 0.72     | 0.16       | 0.90      | 0.25    |
| Daily emoji reminders                      | 0.11     | 0.10       | 0.43      | 0.17    |

Jev ranked the measured saving the chat model rejected first, scored the invented percentage as not measurable, and flagged the duplicate. Proposed split: deterministic code computes evidence, the chat model writes candidates, Jev scores them, and only candidates above a threshold reach the user; the threshold is tuned from the user's accept and dismiss record.

### Experiment: a stalled periodic job

The periodic report's run history, replayed:

- The last real report was posted on day 3 of the job (for the day before yesterday). The next reporting date never became complete, so every later run waited for it and ended `[SILENT]`. Later dates had data, but the instruction only allows the next date after the last published one.
- At the end of the copy, the job had gone 89 runs and 12 days without a report. Nobody was told. The 76 runs after the second silent day cost $29.90.
- The agent had already written its own check script in `scratch/`, yet each run still spent a median of 9 tool calls re-reading guides and re-running it.

Detection does not need a model: "no report for twice the expected interval" (here 14 runs, two days) fires on the second silent day. Whether to tell someone is a judgment, so it went to Jev:

| State given to Jev                                                                     | `stuck` (will not recover alone) | `tell` (notify the requester now)                       |
| -------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| Raw: job instruction, last tool outputs, with or without run history, 7 points in time | 0.44 to 0.55 everywhere          | 0.07 to 0.12 everywhere                                 |
| Computed facts: last report, runs since, next date needed, dates with data             | 0.44 to 0.55, no separation      | 0.31 right after a report, 0.74 to 0.77 from day two on |

Jev did not detect the stall from raw context; the job instruction's "stay silent" dominated. Given computed facts, it separated "tell now" cleanly. Conclusion: code detects, Jev decides whether it is worth interrupting someone, matching the proposal-judging result.

### Where Jev sits today and where it fits proactivity

| Caller             | When                                                                                                         | Question                                  | Proactivity use                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slack_auto_reply` | Each channel message in `jev` mode                                                                           | Is mikan addressed?                       | Leave as is. Offering unsolicited help in channels is where published false-alarm rates reach about 50%.                                                                |
| `task_intent`      | DM message while tasks run                                                                                   | Status, steer, or new request?            | None.                                                                                                                                                                   |
| `memory_capture`   | After each human run                                                                                         | Does the exchange hold durable knowledge? | Add one `choice` question: which job the request was, from a fixed vocabulary. Near-zero cost ($0.0056 for 242), and it builds the request ledger pattern mining needs. |
| `jev_tool`         | Agent-called                                                                                                 | Any                                       | Self-check of a task's finish condition before reporting done. Untested.                                                                                                |
| `jev_browser`      | Browser automation decisions                                                                                 | Page judgments                            | None.                                                                                                                                                                   |
| new: review        | Before a proposal reaches the user                                                                           | Evidence, measurable, duplicate, propose  | Tested above: ranked the measured saving first and rejected the decoys.                                                                                                 |
| new: notify        | After code detects an anomaly in mikan's own runs (stalled or mostly silent periodic job, repeated failures) | Tell the requester now?                   | Tested above: separates once facts are computed.                                                                                                                        |
