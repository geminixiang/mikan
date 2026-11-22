---
status: accepted
---

# Suggested replies

A reply may end with one or two lines starting with `↳`: what the person would most likely send next, in their words. mikan takes those lines off the final answer and hands them to the platform adapter as `suggestions`. Slack shows them as buttons under the reply; a tap sends the line as the tapping person's message. Other adapters show the reply without the lines.

## Context

The owner wanted the agent to offer, after a reply, the one or two things a person would most likely say next, so they tap instead of typing. `slack_blockkit` could do that and never did: with the tool available and the prompt as it was, no model offered a suggestion in sixty runs.

[docs/research/reply-suggestions-2026-11.md](../research/reply-suggestions-2026-11.md) has the reference design, the candidates, the measurements, and the acceptance eval. What they established:

- A prompt section that tells the model to call the tool gets suggestions from the strongest model always and from the others on under half the replies, and costs a second model request and a second message per reply.
- A convention in the reply text is used more often on every model that does not already always use the tool, in one request.
- Rules stated more strictly made the convention's one mistake, a guessed answer offered after the agent asked a question, more frequent. Examples removed it. With the section chosen, the models a deployment runs on gave a wanted suggestion on three replies in four or more, an unwanted one on at most one reply in twenty over both message sets, and never more than two lines.
- The final answer reaches every adapter at one place, `publishFinalResponse` in `src/harness/presenter.ts`.

## Decision

- **Convention.** `src/harness/suggestions.ts` owns the mark, the limit of two, the prompt section, and `splitSuggestions`. The parser removes the trailing run of lines that start with the mark, drops empty ones, and keeps the first two. A marked line anywhere else stays text. A reply that is only marked lines is left as the model wrote it, so a reply is never blanked.
- **No judgement in the core.** The core does not decide whether suggestions fit a reply. It never drops them because the reply ends in a question or for any other reason about content.
- **Prompt.** The section is the last wording in the research doc's table, appended at the end of the system prompt, where it was measured. It is included only when the adapter reports `showsSuggestedReplies` in its `MessagingInfo`. Slack reports it. The prompt of every other platform is unchanged to the byte.
- **Seam.** `publishFinalResponse` splits the final text before the trigger signature is appended and passes `suggestions` in `ReplaceResponseOptions`. This happens on every platform, so a model that writes the lines anyway never shows them as text in a final reply.
- **Renderer.** The progressive renderer gives the suggestions to the write of the last message of a final answer through an optional `withSuggestions` writer the platform supplies. A platform without it is written exactly as before. A final answer that carries suggestions is always written with a message update, also when it only extends a native stream, and is not drawn again when the work ends.
- **Slack.** `src/adapters/slack/suggested-replies.ts` owns the block ID, the action ID prefix, and Slack's limits. It appends one `actions` block after the blocks `renderSlackBlocks` returns, which stay untouched. A label longer than 75 characters ends in an ellipsis while the button's value holds the whole line; a line longer than a value may be (2,000 characters) gets no button. When the message has no room for another block, or Slack rejects the message with the buttons, the reply is sent without them.
- **Tap.** A `block_actions` click whose action ID has the prefix becomes a message from the person who clicked: the line is the text the model receives and the text in `log.jsonl`, in the session an ordinary message at that place would reach. Every other click still arrives as `[Slack action] <action_id>: <value>`. After the tap mikan updates the message with the blocks from the click's payload, the suggestions block replaced by a line of context naming the person and the line. A failed update is logged and does not stop the run.
- **Counting.** The Slack entry for a final reply in `log.jsonl` carries the `suggestions` handed to Slack with it, and the entry for a tap keeps `slackInteraction.actionId`.

## Options considered

| Option                                                               | Why not                                                                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A. Leave it to `slack_blockkit` and the prompt as it was             | No suggestion in sixty runs on three models.                                                                               |
| B. A prompt section telling the model to call the tool after a reply | Two model requests and two messages per reply, under half the replies on two of three models, and one tool per platform.   |
| C. `↳` lines in the reply, parsed by the core (chosen)               | —                                                                                                                          |
| Drop suggestions in the core when the reply ends in a question       | Judgement made for the model. The examples in the section removed the mistake it would have covered.                       |
| Strip the lines while the answer streams                             | A partial answer cannot tell a marked line in the middle from one at the end. The final write removes them.                |
| Rewrite the stored assistant message without the lines               | The session is Pi's record of what the model wrote, and the lines tell the model what it offered when the person taps one. |
| Change `renderSlackBlocks` to emit the buttons                       | The conversion is pinned by a snapshot and shared with `slack_blockkit`; the buttons are not Markdown.                     |
| Re-render the message from `log.jsonl` to remove the buttons         | A continuation message has no log entry of its own. The click's payload holds the blocks of the message that was clicked.  |
| Show the section on every platform                                   | A platform without buttons would be told to write lines nobody can tap.                                                    |

## Consequences

- The session transcript keeps the lines. The `history` tool, the session view, and compaction see the reply as the model wrote it; the chat and `log.jsonl` do not have the lines, and neither does a thread or another session seeded from the log. History sync skips a run's own answer by its session key, not by comparing text, so the difference adds nothing to the session.
- While an answer streams, the lines are visible as text until the final write replaces them.
- Buttons stay until someone taps one. A person who types instead leaves them under the old reply, and a tap there later sends that line into the conversation as it is then.
- In a channel anyone can tap, and the message is theirs. Two people tapping before the update lands send two messages.
- Slack shows no message from the person for a tap. The buttons are replaced by one line of context naming who tapped and the line they sent, so a channel can see what the agent is answering. The line is also in `log.jsonl` and in the session.
- A subagent inherits the conversation's prompt and is told that its answer, a tool result nobody taps, ends without suggested replies.
- A tap gets no acknowledging reaction: its message has no Slack timestamp to react to.
- A long reply is continued in a thread under its first message, and the buttons are on the last continuation. A tap there is a message in that thread, so it reaches the thread's session, as a typed reply there would.
- Two paths send the reply without buttons: Slack's `msg_too_long` fallback, which shortens the first message and continues in the thread, and replies to slash commands, which do not go through the progressive renderer.
- A subagent inherits its parent's system prompt, section included, and its answer is a tool result, which the core does not parse. Its parent may read `↳` lines there.
- Telegram, Discord, and GitHub ignore `suggestions`. Telegram is the next adapter to show them.
- About 200 lines of production code, 820 characters in every Slack system prompt, and no new tool schema.

## Removal condition

Checked ninety days after the release that carries this (2027-02-20 if it ships on 2026-11-22), from the `log.jsonl` files of production offices over that period:

- final replies: Slack bot entries with `replyTo`; those carrying a suggestion: the ones with `suggestions`;
- suggestions shown: the sum of the lengths of `suggestions`; tapped: entries whose `slackInteraction.actionId` starts with `suggested_reply_`;
- shown is counted slightly high: a reply with no room for another block, or a line over 2,000 characters, is recorded although its button was not sent.

```bash
cat */log.jsonl | jq -s '{
  finals: map(select(.isMessagingBot and .platform == "slack" and .replyTo)) | length,
  with_suggestions: map(select(.suggestions)) | length,
  shown: map(.suggestions // [] | length) | add,
  tapped: map(select((.slackInteraction.actionId // "") | startswith("suggested_reply_"))) | length
}'
```

If fewer than one final reply in twenty carries a suggestion, or fewer than one shown suggestion in twenty is tapped, remove the section, the parser, the renderer hook, and the Slack block and tap handling. The remaining path is typing the reply; `slack_blockkit` remains for questions with fixed choices.
