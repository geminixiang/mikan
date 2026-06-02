---
name: slack-block-kit
description: Lessons and implementation guidance for adding Slack Block Kit support to mikan. Use when changing Slack Block Kit rendering, tools, logging, interactions, or response lifecycle behavior.
license: MIT
---

# Slack Block Kit Notes for mikan

## Hard-won lessons

### 1. Do not guess when Slack UI differs from code expectations

When Slack shows plain text instead of Block Kit, instrument every Slack write path before theorizing.

Log at least:

- outbound `chat.postMessage` / `chat.update` payload digest
- Slack API response digest
- canonical message fetched back via `conversations.history`
- all later `chat.update` / `chat.delete` calls for the same `ts`

The decisive debug pattern:

```text
Slack chat.postMessage blocks ... {"hasBlocks":true}
Slack canonical after_post_blocks ... {"hasBlocks":true}
Slack chat.update ... {"hasBlocks":false}
Slack canonical after_update ... {"blockTypes":["rich_text"]}
```

This proves mikan sent valid blocks and then later cleared them with a plain-text update.

### 2. `setWorking(false)` can silently destroy Block Kit

mikan's Slack response lifecycle normally posts/updates one main message while work is in progress. After a Block Kit final response is posted, `setWorking(false)` may still run and call:

```ts
slack.updateMessage(channelId, messageTs, displayText);
```

If that update omits `blocks`, Slack replaces the Block Kit message with plain text/rich_text.

Fix pattern:

```ts
let blockKitFinalized = false;

respondBlockKit(...) {
  blockKitFinalized = true;
  // post blocks
}

setWorking(false) {
  if (blockKitFinalized) {
    // clear assistant status only; do not update the main message
    return;
  }
  // normal text update path
}
```

### 3. A Block Kit tool should not use the normal streaming text path

The generic `respond()` / `replaceResponse()` path is optimized for text streaming and final text replacement. Interactive Block Kit is a final visible response and should use a Slack-specific hook.

Good pattern:

```ts
interface ChatResponseContext {
  respondBlockKit?(response: ChatResponseBlockKit): Promise<void>;
}
```

Slack implements it with direct block posting:

- top-level: `postBlocks(channel, text, blocks)`
- threaded: `postInThreadBlocks(channel, threadTs, text, blocks)`

The tool calls `respondBlockKit` on Slack, falling back to text on other platforms.

### 4. Tool-handled final responses must stop later visible output

If a tool sends the final visible response, mark the run state:

```ts
runState.finalResponseHandledByTool = true;
```

Then skip:

- queued visible response updates after the tool
- finalizer replacement

But still allow diagnostics/usage where appropriate.

### 5. Runtime validation is still needed even with Slack SDK types

`@slack/types` provides TypeScript types such as `KnownBlock`, `ActionsBlock`, and `MultiStaticSelect`, but LLM-generated JSON arrives at runtime. TypeScript cannot validate it.

Use runtime validation for:

- allowed block types
- allowed interactive element types
- required `action_id`
- required button `value`
- placement rules that are empirically reliable for mikan

### 6. Prefer conservative placement rules for LLM-generated Block Kit

For mikan's `slack_blockkit` tool:

- buttons go in `actions.elements`
- `static_select` and `multi_static_select` go in `section.accessory`
- each interactive element must have `action_id`
- buttons must have `value`

When the LLM put `multi_static_select` in `actions.elements`, Slack returned `invalid_blocks` / `unsupported element`. The safer rule is to force selects into `section.accessory`.

### 7. Slack may auto-fill `block_id`

Slack can return canonical blocks with generated `block_id`s even if mikan did not send them. This is useful evidence in response/canonical logs, but do not rely on generated IDs for mikan-side routing. Prefer explicit `block_id` if the interaction needs stable semantics.

### 8. Slack Socket Mode may emit `interactive`, not `block_actions`

Do not assume the Socket Mode event name is only `block_actions`. In testing, Slack button/select clicks arrived through the `interactive` listener.

Good pattern:

```ts
socketClient.on("block_actions", (payload) => handleBlockAction(payload));
socketClient.on("interactive", (payload) => handleBlockAction(payload));
```

If clicks do not reach mikan, first add a short-lived event-name log around these listeners. Do not start by changing app scopes or rewriting interaction code.

### 9. Log both outbound blocks and user interactions

For mikan memory/debuggability, `log.jsonl` should preserve Slack-specific fields without changing Telegram/Discord logs.

Bot Block Kit response example:

```json
{
  "platform": "slack",
  "slackBlocks": [...]
}
```

Interaction example:

```json
{
  "platform": "slack",
  "slackInteraction": {
    "type": "block_actions",
    "actionId": "multi_select_food",
    "blockId": "...",
    "actionType": "multi_static_select",
    "selectedOptions": [{ "text": "壽司", "value": "sushi" }],
    "messageTs": "..."
  }
}
```

Keep Slack fields optional and Slack-prefixed so other adapters are unaffected.

### 10. Action events need human-readable labels, not only raw values

A thin event such as:

```text
[Slack action] q4_c: wrong
```

is not enough for good follow-up behavior. The LLM may not know what the user selected, what the visible label was, or what question the action belonged to.

Prefer event text that includes the visible selected label and value:

```text
[Slack action] q4_c: selected "C. 六尾" (value: wrong)
[Slack action] multi_select_food: selected "壽喜燒", "天婦羅" (values: sukiyaki, tempura)
```

For quizzes or any button convention using `value: "correct" | "wrong"`, this lets the assistant provide better feedback. If possible, also derive the selected label from `action.text.text` and select labels from `selected_option(s)`.

### 11. Top-level/thread routing should match normal Slack replies

For consistency with mikan's Slack conversation model:

- top-level message action -> top-level session/response
- thread message action -> thread session/response

Do not automatically route top-level action clicks into a new thread using `container.message_ts` as `thread_ts`. Use only `container.thread_ts` for thread routing.

Bad pattern:

```ts
const threadTs = container.thread_ts ?? container.message_ts;
```

Good pattern:

```ts
const threadTs = container.thread_ts;
```

### 12. Synthetic Slack action IDs must not look like Slack message timestamps

If a synthetic action event uses a numeric timestamp like `1780386674.744609`, Slack response planning may mistake it for a real Slack message timestamp and call Assistant status APIs with an invalid `thread_ts`.

Use a non-Slack-shaped event id:

```ts
const ts = `action:${Date.now()}`;
```

This avoids `invalid_thread_ts` from `assistant.threads.setStatus` for top-level action events.

### 13. Tool errors must propagate to the LLM

Do not send Block Kit through a response helper that catches and swallows Slack API errors. If Slack rejects blocks with `invalid_blocks`, the tool must fail so the LLM can retry with corrected blocks.

Bad symptom:

```text
Slack respondBlockKit error: invalid_blocks
✓ slack_blockkit
Sent Slack Block Kit response
```

Correct behavior:

```text
✗ slack_blockkit
invalid_blocks
```

Only mark `finalResponseHandledByTool` / `blockKitFinalized` after the block post succeeds.

### 14. Prompt only Slack users about Slack Block Kit

The Slack Block Kit system prompt section should be conditional on `platform.name === "slack"`. Do not show Slack-only UI instructions to Telegram or Discord runs.

## Debug checklist

When Block Kit does not render or disappears:

1. Verify magic-word/direct `postBlocks` still renders.
2. Check outbound `postMessage` digest has `hasBlocks:true`.
3. Check Slack API response has blocks.
4. Fetch canonical message with `conversations.history`; verify it has blocks.
5. Search later logs for `chat.update` on the same `ts`.
6. If a later update has `hasBlocks:false`, that update cleared Block Kit.
7. If canonical has blocks but Slack UI is plain text, suspect Slack client/render/surface behavior.
8. If canonical lacks blocks, suspect invalid payload/schema or Slack server rejection.

## Design guidance

- Text remains mikan's main conversation channel.
- Use Block Kit only when structured choice or visual layout helps.
- Interactive Block Kit is not single-use by default; Slack allows repeat clicks. Add lifecycle/state before using it for dangerous operations.
- For first versions, restrict interaction types and avoid destructive actions.
- Treat a successful Block Kit tool call as the final visible response for that run.
