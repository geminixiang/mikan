# src/adapters/slack

This directory implements the Slack platform adapter and Slack-specific session/thread rules.

## Files

- `bot.ts`: Implements the Slack Socket Mode/Web API bot, including events, backfill, threads, replies, working state, slash commands, Block Kit interactions, and logging. Also owns Slack file intake: `processAttachments` builds the download items (Slack file URLs need the bot token, so `downloadSlackFile` retries with authorization) and hands them to `saveIncomingAttachments` for storage under the conversation's office.
- `blocks.ts`: Renders response-source Markdown as native Block Kit — prose is sliced verbatim into `markdown` blocks so Slack owns prose rendering (ADR 0001), GFM tables become `table` blocks, and a plain-text fallback is derived for notifications. Also owns `resolveSlackMentions`, which converts response-source `<@userName>` / display-name mentions into native `<@U…>`; already-native ids pass through and unknown names stay verbatim.
- `update-diagnostics.ts`: Best-effort, content-free `chat.update` rejection breadcrumbs and first-recovery breadcrumbs/structured logs. Tracks at most 128 failed message identities per bot for ten minutes; never changes payloads, errors, or retries. Validation text is classified, not copied. Message identifiers reuse existing response attribution; successful recovery logs remain queryable even without a later error event.
- `context.ts`: Assembles the Slack `ConversationContext` — session plan, `ConversationMessage`, responder, and the bot's `MessagingInfo`.
- `response-lifecycle.ts`: Builds the Slack `ConversationResponder` on the shared progressive renderer: native streaming in threads and buffered updates elsewhere, tool output, assistant working status, thread diagnostics, and the `msg_too_long` fallback that shrinks the prefix and continues in-thread.
- `session.ts`: Handles Slack channel/thread session keys, root timestamps, and event-anchor planning.
- `tool-pack.ts`: Binds the Slack tool pack per run, enabling it only for Slack conversations and confining `slack_blockkit` to the active conversation thread and messages it posted.
- `types.ts`: Slack event/user/channel shapes, the session plan, block-action payload subsets, and the host-side `PlatformSlackOps` contract.

## Subdirectories

- `tools/`: Agent tools required by the Slack adapter.

## Behavior notes

- Outgoing text is mention-resolved and rendered to Block Kit on every path that
  carries response source: `postMessage`, `updateMessage`, `postInThread`, and
  the streaming calls (`chat.startStream` / `chat.appendStream` send
  `markdown_text`). A mention split across two stream deltas stays unresolved in
  the provisional text; the final canonical `updateMessage` render resolves it.
  `userName` wins over `displayName` when both match a name.

## DM tasks

Top-level DM responders expose `startTask(message, task)`. Admission posts a
persistent acknowledgement, records `taskRoot` on its platform log entry, creates
an empty scoped session, and queues a self-contained task plus the original
attachments under that root. Task output uses the thread responder; it does not
replace the acknowledgement. Ordinary event scheduling is unchanged.

Text in an active DM task thread bypasses the adapter run queue and calls the
runtime steering port. Idle threads use normal prompt execution (including
explicit continuation after stop). Stop keeps its magic-word path. Shared channels
and non-task threads retain their existing trigger/queue policy. Task-root
recognition survives restart through the office log, but automatic crash recovery
and task control from natural-language main-DM references are not implemented.

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

DMs and task threads share a narrow, full-message shortcut for common pure status
questions. This reads state without a model call or steering. Mixed requests
(e.g. status plus a changed instruction) still follow normal agent handling;
this is not a general natural-language intent classifier. Other main-DM free-form
queries use the model's read-only task_status tool. Status-only tool activity
is not shown in the progress list. Plain textual followups and status-only
runs no longer send completion mentions; initial handoffs (including reasoning-only tasks) and runs doing other tools still do.

Pure status queries select the sole active task in main DM; multiple active tasks
require explicit disambiguation. Historical selection defaults to the latest task.
Execution completion no longer asserts successful delivery. Historical snapshots
are read sequentially to avoid retaining ten full session snapshots concurrently.
