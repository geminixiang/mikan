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
- mikan does not use Slack's agent surface beyond the working status. It still acknowledges `app_home_opened`, `app_context_changed`, and the two `assistant_thread_*` events, because an app configured by hand may stay subscribed and Slack redelivers an event nobody acknowledges.

## App configuration

- `app-config.ts` owns the Slack app manifest; `deploy/examples/slack-app-manifest.json` must equal `slackAppManifest()`, and slash commands come from the command manifest. With `slack-config-token.json` in the state directory, startup rotates the token, exports the live app, and replaces it when it differs, so the live app equals the manifest plus `slack.json`'s display fields (ADR 0026). Sync failures are logged and never stop startup.
- Rotation revokes the previous access token, while the previous refresh token keeps working for a while, so the newest pair is saved before any other call. Two installs sharing one token revoke each other's access tokens.
- Slack sets some fields itself and ignores what is sent for them: `features.app_home.agent_tasks_enabled` is on for apps created after Slack added it and absent on older ones. The comparison skips these fields; otherwise every start would update the app.

## Runs

Task threads were removed (ADR 0032). A thread that a task started before the removal is an
ordinary thread session: a reply there runs a normal turn.

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

Magic-word stop carries the source thread independently of the execution target
(which may fall back to a parent session). Its acknowledgement and final update
stay in that source thread. Shared-channel bare thread `stop` reaches control
intake even though ordinary unmentioned thread messages do not trigger runs.
