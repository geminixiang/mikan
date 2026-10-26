# src/adapters/slack

This directory implements the Slack platform adapter and Slack-specific session/thread rules.

## Behavior notes

- Outgoing text is mention-resolved and rendered to Block Kit on every path that
  carries response source: `postMessage`, `updateMessage`, `postInThread`, and
  the streaming calls (`chat.startStream` / `chat.appendStream` send
  `markdown_text`). A mention split across two stream deltas stays unresolved in
  the provisional text; the final canonical `updateMessage` render resolves it.
  `userName` wins over `displayName` when both match a name.
- Incoming text arrives with `&`, `<`, and `>` escaped as `&amp;`, `&lt;`, and `&gt;`. Every inbound path (live events, backfill, and external-bot messages) undoes the escaping before the office log or the runtime sees the text, because the model otherwise reads `&amp;&amp;` where the user typed `&&`. Slack's `<@U…>`, `<#C…>`, and `<url>` markup is left intact.
- Slack file URLs need the bot token. `downloadSlackFile` sends it only to HTTPS `slack.com` hosts, retries transient failures, and hands the items to `saveIncomingAttachments`.
- `blocks.ts` slices prose verbatim into `markdown` blocks so Slack owns prose rendering (ADR 0001); GFM tables become `table` blocks, and a plain-text fallback is derived for notifications.
- On `msg_too_long`, `response-lifecycle.ts` shrinks the prefix and continues in the thread.
- Native streaming (`chat.startStream`) is used only for replies in a thread: in an ordinary channel Slack rejects a stream without `thread_ts`. Top-level and DM replies are updated with `chat.update`, paced by the progressive renderer.
- While a buffered reply is being written, it ends with `...` as its own paragraph. Slack rejects an update that turns a message of `rich_text` blocks into one of only a header or table (`block_mismatch`), and an inline `...` joined the last heading or table cell, so the separate paragraph keeps the shape Slack accepts while headings and tables grow. The final write drops it.
- `slack_blockkit` is confined to the active conversation thread and to messages it posted. Interactions return through `block_actions` as `[Slack action]` conversation events.
- `update-diagnostics.ts` records content-free `chat.update` rejection breadcrumbs for at most 128 message identities over ten minutes and never changes payloads, errors, or retries.
- `@slack/socket-mode` (2.x with `ws`, and 3.x with undici) sets no deadline on `apps.connections.open` or the WebSocket handshake, so a peer that accepts TCP and never answers stalls startup or a reconnect forever without a log line. `SlackSocketAgent` destroys a socket that stays silent for 30s, and socket-mode then retries on its own. `ws` calls `setTimeout(0)` once the upgrade completes, so an idle live connection is never cut; the ping monitor (`clientPingTimeout`) covers it from then on. The agent depends on that `ws` behavior, so recheck it when moving to socket-mode 3.x.
- `close` and `connected` socket events log `Slack connection lost; reconnecting` and `Slack reconnected after Ns`; socket-mode 2.x emits neither `disconnect` nor `unable_to_socket_mode_start`.
- `@slack/socket-mode` rejects `start()` with `undefined` when `disconnect()` interrupts a connection attempt. `start()` treats that rejection as a normal stop once `stop()` has run; otherwise `main.ts` would log `Failed to start bot undefined` and exit with code 1 in the middle of a graceful shutdown.
- DM task intent (`task-intent.ts`) is classified by Jev and falls back to `isTaskStatusQuestion` when Jev is unavailable.

## App configuration

- `app-config.ts` owns the Slack app manifest; `deploy/examples/slack-app-manifest.json` must equal `slackAppManifest()`, and slash commands come from the command manifest. With `slack-config-token.json` in the state directory, startup rotates the token, exports the live app, and replaces it when it differs, so the live app equals the manifest plus `slack.json`'s display fields (ADR 0026). Sync failures are logged and never stop startup.
- Rotation revokes the previous access token, while the previous refresh token keeps working for a while, so the newest pair is saved before any other call. Two installs sharing one token revoke each other's access tokens.
- Slack sets some fields itself and ignores what is sent for them: `features.app_home.agent_tasks_enabled` is on for apps created after Slack added it and absent on older ones. The comparison skips these fields; otherwise every start would update the app.

## Tasks

Top-level responders, in DMs and channels, expose `startTask(message, task)`. Admission posts a
persistent acknowledgement, creates the task's session as a child conversation
owned by a background task of the requesting session whose input holds the
acknowledgement (`SessionStore.openTask`, ADR 0021), and queues a self-contained task plus
the original attachments under that root. Task output uses the thread responder; it does not
replace the acknowledgement. Ordinary event scheduling is unchanged.

Text in a DM task thread, and top-level DM text while a task thread is running,
is classified by Jev (`task-intent.ts`) before any model turn: `status` answers
from observation, `steer` calls the runtime steering port (a top-level supplement
is steered only when exactly one task is running), and `request` falls through
to normal prompt execution. Slash commands always fall through. Attachments skip
Jev: in a task thread they go to steering, which rejects them with a request to
stop first; top-level attachments are a normal turn.
Without Jev the regex status shortcut decides `status`, thread text is tried as
steering, and top-level text is a normal turn — the pre-Jev behavior. Idle
threads use normal prompt execution (including explicit continuation after
stop). Stop keeps its magic-word path. In a channel, only a mention in a task
thread takes this path, because other people talk there too: unmentioned thread
replies and top-level mentions keep the channel's trigger/queue policy, and a
top-level question about a task is a normal turn that can call `task_status`.
Steering accepts only the task's requester (`steerRun`); anyone in the channel can
ask for status. Non-task threads retain their existing trigger/queue policy. Which threads are tasks, their
acknowledgements, and their run state come from pi-durable (`SessionStore.listTasks`
and `isTask`), not from the office log, so they survive a restart or a lost log.
Task threads started before 1.1.0 were ordinary thread sessions and are not
recognized.

Every Slack run outlives a restart (ADR 0027). The Slack platform reports
`continuesInterruptedRuns`, so shutdown neither waits for its runs nor aborts
them, and `stop()` closes the queues without waiting. At startup, before the
socket connects and before backfill, the bot asks `SessionStore.continueInterrupted`
for each channel, posts "Restarted for an update; continuing." where each
interrupted session replies, and queues a run with `continuedRunId(sessionKey)`,
which continues the pending turn instead of submitting input. It runs before the
socket connects because the first message to an office would otherwise open it
and abort its interrupted runs. A message queued behind a run but not yet started
when the process stops is lost, as before.

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
read-only snapshot of the durable session, without claiming the live writer. A run
still recorded as open with no active runtime is unknown, not claimed to be running. Task acknowledgement
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
