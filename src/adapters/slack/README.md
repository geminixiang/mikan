# src/adapters/slack

This directory implements the Slack platform adapter and Slack-specific session/thread rules.

## Behavior notes

- Outgoing text is mention-resolved and rendered to Block Kit on every path that
  carries response source: `postMessage`, `updateMessage`, `postInThread`, and
  the streaming calls (`chat.startStream` / `chat.appendStream` send
  `markdown_text`). A mention split across two stream deltas stays unresolved in
  the provisional text; the final canonical `updateMessage` render resolves it.
  `userName` wins over `displayName` when both match a name.
- Slack file URLs need the bot token. `downloadSlackFile` sends it only to HTTPS `slack.com` hosts, retries transient failures, and hands the items to `saveIncomingAttachments`.
- `blocks.ts` slices prose verbatim into `markdown` blocks so Slack owns prose rendering (ADR 0001); GFM tables become `table` blocks, and a plain-text fallback is derived for notifications.
- On `msg_too_long`, `response-lifecycle.ts` shrinks the prefix and continues in the thread.
- `slack_blockkit` is confined to the active conversation thread and to messages it posted. Interactions return through `block_actions` as `[Slack action]` conversation events.
- `update-diagnostics.ts` records content-free `chat.update` rejection breadcrumbs for at most 128 message identities over ten minutes and never changes payloads, errors, or retries.
- DM task intent (`task-intent.ts`) is classified by Jev and falls back to `isTaskStatusQuestion` when Jev is unavailable.

## DM tasks

Top-level DM responders expose `startTask(message, task)`. Admission posts a
persistent acknowledgement, records `taskRoot` on its platform log entry, creates
an empty scoped session, and queues a self-contained task plus the original
attachments under that root. Task output uses the thread responder; it does not
replace the acknowledgement. Ordinary event scheduling is unchanged.

Text in a DM task thread, and top-level DM text while a task thread is running,
is classified by Jev (`task-intent.ts`) before any model turn: `status` answers
from observation, `steer` calls the runtime steering port (a top-level supplement
is steered only when exactly one task is running), and `request` falls through
to normal prompt execution. Attachments and slash commands always fall through.
Without Jev the regex status shortcut decides `status`, thread text is tried as
steering, and top-level text is a normal turn — the pre-Jev behavior. Idle
threads use normal prompt execution (including explicit continuation after
stop). Stop keeps its magic-word path. Shared channels and non-task threads
retain their existing trigger/queue policy. Task-root recognition survives
restart through the office log, but automatic crash recovery is not implemented.

Task response finalization posts one fresh in-thread message mentioning the current
requester after a normal textual completion. Aborted, error and silent turns do
not send a completion notice. This signals delivery of a result, not a claim that
all requested actions succeeded. Slack notification preferences still control
push/banner delivery.

Magic-word stop carries the source thread independently of the execution target
(which may fall back to a parent session). Its acknowledgement and final update
stay in that source thread. Shared-channel bare thread `stop` reaches control
intake even though ordinary unmentioned thread messages do not trigger runs.

### Task status observations

`task_status` is bound to the current DM's recent task anchors (ten historical entries plus all active tasks).
Active state comes from the existing runtime; terminal outcomes come from a
read-only v4 snapshot, without claiming the live writer. An open operation with
no active runtime is unknown, not claimed to be running. Task acknowledgement
text identifies the work, not its current progress. No ETA is inferred.

Pure status questions (Jev `status`, or the regex shortcut without Jev) read
state without a model call or steering. Mixed requests (status plus a changed
instruction) are steered when Jev classifies them so, and otherwise follow
normal agent handling. Other main-DM free-form queries use the model's read-only
task_status tool. Status-only tool activity
is not shown in the progress list. Plain textual followups and status-only
runs no longer send completion mentions; initial handoffs (including reasoning-only tasks) and runs doing other tools still do.

Pure status queries select the sole active task in main DM; multiple active tasks
require explicit disambiguation. Historical selection defaults to the latest task.
Execution completion no longer asserts successful delivery. Historical snapshots
are read sequentially to avoid retaining ten full session snapshots concurrently.
