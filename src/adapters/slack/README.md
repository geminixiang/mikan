# src/adapters/slack

This directory implements the Slack platform adapter and Slack-specific session/thread rules.

## Files

- `bot.ts`: Implements the Slack Socket Mode/Web API bot, including events, backfill, threads, replies, working state, slash commands, Block Kit interactions, and logging. Also owns Slack file intake: `processAttachments` builds the download items (Slack file URLs need the bot token, so `downloadSlackFile` retries with authorization) and hands them to `saveIncomingAttachments` for storage under the conversation's office.
- `blocks.ts`: Renders response-source Markdown as native Block Kit — prose is sliced verbatim into `markdown` blocks so Slack owns prose rendering (ADR 0001), GFM tables become `table` blocks, and a plain-text fallback is derived for notifications. Also owns `resolveSlackMentions`, which converts response-source `<@userName>` / display-name mentions into native `<@U…>`; already-native ids pass through and unknown names stay verbatim.
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
