# Suggested replies (2026-11)

What the owner wants from `slack_blockkit` is not Block Kit: after a reply, offer one or two things the person would most likely say next, so they tap instead of typing. The model rarely does that with the tool. The owner's reference is pi-mobile, where it is not a tool: a reply ends with lines starting with `↳`, written in the person's voice, and the app turns them into buttons that send the line as the person's message. This page compares the ways to get there and measures them. Nothing is implemented yet.

## The reference

pi-mobile (`src/interaction/replies.ts`): a prompt section of about 400 characters, a parser that takes the trailing `↳` lines off the answer and keeps at most two, and a renderer. The answer's text, copies, and notification summaries leave the lines out. A question that must be answered before the agent can go on is a separate `ask_user` tool, not `↳`. Its change log records that the same section produced suggestions on three of three questions with one model and on none with another.

## mikan today

- `slack_blockkit` posts a message with buttons or a menu (narrowed on 2026-11-22). A click arrives as `[Slack action] <id>: <value>`. It is a tool call, so the model has to decide to make it, and the reply it accompanies is a second message.
- The final answer reaches every adapter at one place: `publishFinalResponse` in `src/harness/presenter.ts` calls `responder.replaceResponse(text, { final: true })`.
- Slack already renders blocks and receives `block_actions`. Telegram's adapter sends text without a `reply_markup`; a Telegram reply keyboard sends the tapped text as an ordinary message, so it needs no intake code. Discord's adapter sends text components and has no interaction handler. GitHub has no buttons.

## Candidates

|                          | A. Today                         | B. Tell the model to use the tool                           | C. `↳` lines in the reply                                                                                                           |
| ------------------------ | -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| How                      | The tool exists; one prompt line | A prompt section: after such a reply, call `slack_blockkit` | A prompt section: end such a reply with one or two `↳` lines; the core parses                                                       |
| Model requests per reply | 1                                | 2: the tool call needs a second request                     | 1                                                                                                                                   |
| What the person sees     | Nothing extra                    | The reply, then a second message holding the buttons        | The reply with buttons under it                                                                                                     |
| Platforms                | Slack                            | Slack; each platform would need its own tool                | Any adapter that can show buttons; the rest show the reply without the lines                                                        |
| New code                 | None                             | A prompt section                                            | A prompt section, a parser at the final-response seam, one renderer per adapter, and Slack's click turned into the person's message |
| Serves the core idea     | —                                | The model drives a tool                                     | The model writes text; the core adds no judgement, it only moves lines                                                              |

## Measurement

`.workspace/reply-suggestions-eval/suggestions.eval.ts` builds the real system prompt for a Slack direct message, offers `read`, `bash`, and the real `slack_blockkit`, and sends one message per run to a real model. Twenty messages, two runs each. Ten hand the person something to use or choose (a draft, a plan, options, steps): a suggestion is wanted. Ten do not (a fact, arithmetic, thanks, a greeting, and two requests the agent cannot carry out without asking back): none is wanted. The section for C is pi-mobile's wording; the section for B asks for the same through the tool.

| Model                        | Approach | Wanted and given | Unwanted and given | Through |
| ---------------------------- | -------- | ---------------- | ------------------ | ------- |
| `openai/gpt-6-luna`          | A. Today | 0 of 20          | 0 of 20            | —       |
|                              | B. Tool  | 8 of 20          | 1 of 20            | tool    |
|                              | C. `↳`   | 13 of 20         | 0 of 20            | text    |
| `anthropic/claude-sonnet-5`  | A. Today | 0 of 20          | 0 of 20            | —       |
|                              | B. Tool  | 20 of 20         | 0 of 20            | tool    |
|                              | C. `↳`   | 20 of 20         | 2 of 20            | text    |
| `anthropic/claude-haiku-5.5` | A. Today | 0 of 20          | 0 of 20            | —       |
|                              | B. Tool  | 9 of 20          | 0 of 20            | tool    |
|                              | C. `↳`   | 20 of 20         | 2 of 20            | text    |

Across all runs of C: no reply had more than two lines, no `↳` line appeared anywhere but the end, none said thanks or OK, and none was written in the agent's voice ("shall I …"). Typical lines: `↳ 改得更正式一點`, `↳ 加上工作交接的部分`, `↳ 幫我寫 Nginx upstream 設定範例`, `↳ Make it more casual`.

### What the numbers say

- **Today nobody gets a suggestion.** The owner's observation holds on three models: with the tool available and the current prompt, zero of sixty.
- **The owner's guess that the prompt is the reason is half right.** A prompt section alone takes the tool from never to always on the strongest model, and to under half on the other two.
- **The convention is used more than the tool on every model that does not already use the tool always**, at half the model requests.
- **The convention's mistake is a specific one.** All but one of its unwanted suggestions came after the agent asked the person for something it needed (who to write to, which folder): the reply asked, and the `↳` lines offered made-up answers such as `↳ 收件人是 xxx@example.com，改到明天下午三點`. Tapping that would send a placeholder. A reworded section ("when your reply asks for something you need, it has no `↳` lines; never put a guessed answer in one") did not help: 4 of 20 on both Claude models, against 2 of 20.

## Wording experiments (2026-11-22, after the owner's go-ahead)

The owner approved C on condition that wording and structure are tried until the acceptance criteria hold on all three models: wanted suggestions no lower than the table above, unwanted on at most 1 of 20, never more than two lines. If they do not hold, stop and report, without a rule in the core that judges for the model. Eight sections were tried. Each cell is the number of runs with a suggestion over the number of runs.

On the twenty messages used for tuning:

| Section                                                                 | Runs per cell | luna wanted | luna unwanted | sonnet wanted | sonnet unwanted | haiku wanted | haiku unwanted |
| ----------------------------------------------------------------------- | ------------- | ----------- | ------------- | ------------- | --------------- | ------------ | -------------- |
| pi-mobile's wording                                                     | 20            | 13          | 0             | 20            | 2               | 20           | 2              |
| + "never put a guessed answer in one"                                   | 20            | 11          | 0             | 20            | 4               | 19           | 4              |
| + "sent exactly as written … never answers a question you asked"        | 20            | 11          | 0             | 15            | 1               | 20           | 3              |
| "Only a reply that finishes what was asked …"                           | 20            | 9           | 1             | 16            | 0               | 20           | 8              |
| the same, with `slack_blockkit` named for fixed choices                 | 20            | 19          | 0             | 17            | 2               | 20           | 4              |
| rule, one positive example, two negative examples                       | 30            | 15          | 0             | 25            | 0               | 26           | 0              |
| the same + "when in doubt, leave them out"                              | 30            | 10          | 0             | 28            | 0               | 22           | 0              |
| rule naming more kinds of reply, two positive and two negative examples | 60            | 49          | 0             | 55            | 0               | 59           | 4              |

The last section on twenty messages it was not tuned on, thirty runs per cell: luna 15 wanted and 0 unwanted, sonnet 23 and 0, haiku 30 and 7.

No run of any section produced more than two lines.

### Findings

- **Examples do what rules do not.** Stating the rule more strictly made the guessed-answer mistake more frequent or cut wanted suggestions. Showing one reply that asks and gets no lines removed the mistake on two of the three models, in 180 runs each.
- **No section meets all the criteria on all three models.** With the best one: the largest model never gives an unwanted suggestion and gives a wanted one on about four replies in five, not on every one; the smallest model gives almost every wanted one and still adds lines after about one unwanted reply in eight, mostly after asking the person for something; the third gives no unwanted ones and a wanted one on half to four in five.
- **The same section varies by several runs in thirty from one sample to the next**, so a table of twenty runs per cell, like the first one on this page, cannot carry a criterion of "20 of 20".
- **A section tuned on twenty messages does worse on twenty others** for two of the three models. The criteria should be judged on messages the wording was not tuned on.

The implementation is on hold for the owner's decision on which criterion gives.

### Which models matter

A deployment in use runs on four GPT-family models through its own gateway; no Claude model is in regular use there. Of that family only `gpt-6-luna` is in the tables above. An attempt to add three more of them failed for a reason that has nothing to do with the models: every run ended with the provider refusing the request for lack of credits, which the harness first recorded as "no suggestion". Those rows are discarded, and the harness now counts a failed run as an error. Four direct requests with a short system prompt show that two of those models do write the lines; what they do under mikan's full prompt is not measured yet.

So the smallest Claude model's unwanted suggestions weigh little, and the criteria have to be judged on the models actually in use, on messages the wording was not tuned on.

### On the models in use

The last section of the table above (the rule naming more kinds of reply, two positive and two negative examples), through the gateway the deployment uses, thirty runs per cell:

| Model          | Tuning set: wanted | Tuning set: unwanted | Held-out set: wanted | Held-out set: unwanted |
| -------------- | ------------------ | -------------------- | -------------------- | ---------------------- |
| `chatgpt`      | 30 of 30           | 0 of 30              | 30 of 30             | 0 of 30                |
| `gpt-5.6-sol`  | 30 of 30           | 0 of 30              | 29 of 30             | 0 of 30                |
| `gpt-6-astra`  | 30 of 30           | 0 of 30              | 29 of 30             | 3 of 30                |
| `gpt-5.6-luna` | 23 of 30           | 0 of 30              | 23 of 30             | 0 of 30                |

No run had more than two lines, a line outside the end of the reply, a thanks or an OK, or a line in the agent's voice. No model offered a guessed answer after asking the person for something: 48 such runs, none. The three unwanted suggestions are all after one message, "git stash 是做什麼的？", where the model explained the command and offered follow-up questions such as "git stash 跟 commit 差在哪？".

Against the criteria: never more than two lines holds. Unwanted suggestions are at most 1 in 20 for every model over both sets (3 of 60 for one, none for the others), though that one model exceeds it on the held-out set alone. Wanted suggestions are on every reply or nearly for three models and on three in four for the fourth, above every figure in the first table. This section is the one to implement.

## Recommendation

Adopt C, in this shape:

1. **Prompt.** One section, pi-mobile's wording, supplied where the adapter can show buttons, so a platform without them is not told to write lines nobody can tap.
2. **Core.** At the final-response seam, take the trailing `↳` lines off the text, keep at most two, and pass them as `suggestions` beside the text. This is parsing, not judgement. The session keeps the reply as the model wrote it; what people see and what is logged leave the lines out.
3. **Adapters.** Slack first: buttons under the final reply; a tap becomes that person's message with the line as its text, and the buttons go away. Telegram next: a one-time reply keyboard, which needs no intake code. Discord needs an interaction handler it does not have, so it comes last or not at all. GitHub ignores suggestions.
4. **`slack_blockkit` stays for now**, as the way to ask a question with fixed choices. Whether suggestions make it unnecessary is decided from production counts after both have run, not now.

## Open points for the implementation

- **Guessed answers after a question.** The measured failure above. Two ways to treat it, to be measured rather than argued: more wording, or a structural rule the model can see, such as offering the choices through the ask path instead. A rule in the core that drops suggestions when the reply ends in a question would be judgement made for the model, and is the last resort.
- **The weakest model gives suggestions on about two replies in three.** A missing suggestion costs nothing; this is a ceiling on the benefit, not a defect.
- **Streaming.** A partial answer shows the `↳` lines as text until the final replacement removes them.
- **Who may tap.** In a channel anyone can press a button. The message is that person's, as a block action is today.
- **Stale buttons.** They are replaced when tapped; whether they are also removed when the person types instead is a choice per adapter.

## Acceptance criteria proposed for the implementation

On the same twenty messages and three models: wanted suggestions at least as often as the table above for C; unwanted suggestions on at most 1 of 20 per model; never more than two; and on a real Slack workspace a tap sends the line as the person's message and the agent answers it. The Markdown conversion snapshot stays unchanged.

## Removal condition

Ninety days after it ships, from production: if fewer than one final reply in twenty carries a suggestion, or fewer than one suggestion in twenty shown is tapped, remove the section, the parser, and the renderers. The remaining path is typing the reply.

## Implementation (2026-11-22)

The owner chose the section measured in "On the models in use". The acceptance eval is `.workspace/reply-suggestions-impl-eval/suggestions-impl.eval.ts`: the Slack bot and the conversation runtime with a fake Socket Mode connection, a fake Web API that keeps the messages a person would see, and Pi's faux provider as the model. The baseline is the commit before the change. The first three columns were written before the implementation; the last was added after it.

| Case                                                                             | Baseline                                                                           | Expected                                                                                                                                                                 | After                                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| a. A reply ending in two `↳` lines, direct message                               | The lines are shown as text and logged; no buttons                                 | Text and `log.jsonl` without the lines; two buttons with those labels                                                                                                    | As expected                                                                              |
| b. Three `↳` lines                                                               | Three lines of text                                                                | Text without them; the first two as buttons                                                                                                                              | As expected                                                                              |
| c. A `↳` line in the middle of the reply                                         | Stays text                                                                         | Stays text; no buttons                                                                                                                                                   | As expected                                                                              |
| d. A reply without lines                                                         | Text; final payload hash `c33adb0918af`                                            | The same payload hash; no buttons                                                                                                                                        | `c33adb0918af`; no buttons                                                               |
| e. Another person taps a suggestion under a channel reply                        | No button exists; a synthetic click arrives as `[bob]: [Slack action] …`           | The model receives `[bob]: Make it shorter`; `log.jsonl` holds that text from that person; the buttons are gone from the message and its text is kept; the agent answers | As expected                                                                              |
| f. A `slack_blockkit` button click (guard)                                       | `[alice]: [Slack action] button_1: yes`; the button stays                          | Unchanged                                                                                                                                                                | Unchanged                                                                                |
| g. A reply of 43,000 characters, split into two messages                         | The lines are text at the end of the second message; no buttons                    | No `↳` in either message; two buttons on the second, last message                                                                                                        | As expected                                                                              |
| h. A reply in a thread, streamed with `chat.startStream`                         | Streamed; lines shown as text                                                      | Streamed; text without the lines; two buttons; a tap is answered in the same thread and the buttons go                                                                   | As expected                                                                              |
| h2. A channel mention                                                            | Top-level reply; lines shown as text                                               | Top-level reply without the lines; two buttons                                                                                                                           | As expected                                                                              |
| i. Telegram and Discord, a reply with two lines                                  | Lines sent and logged as text; no error                                            | Text sent and logged without the lines; no error                                                                                                                         | As expected                                                                              |
| j. System prompt                                                                 | No section on any platform (hashes `8a7f71ffba8f`, `fe3994795378`, `79d5bab933b8`) | Slack: the old prompt plus the section at the end; Telegram and Discord: the same hashes                                                                                 | Slack: section at the end, and `8a7f71ffba8f` without it; the other two hashes unchanged |
| k. Upgrade: a session whose history was written before the change gets a message | The earlier question and reply are in the model's context                          | The same, and the new reply gets its button                                                                                                                              | As expected                                                                              |
| l. `src/test/slack-markdown-conversion.test.ts` and its snapshot                 | Pass                                                                               | Pass, with neither file changed                                                                                                                                          | 13 tests pass; neither file changed                                                      |

What the eval showed that the plan did not have:

- **A split reply was drawn twice.** When the work ends, the renderer draws the view again if it differs from what is shown. For a reply over Slack's length, the view is the shortened single message, so on the baseline the first message of a split reply is rewritten to end in "message truncated" although its continuation is posted. With suggestions that redraw put the buttons on both messages. A final answer that carried suggestions is now not drawn again; a reply without suggestions behaves as on the baseline.
- **A tap on a split reply goes to a thread.** The continuation is posted in a thread under the first message, so the buttons are in that thread and the tap is a message there. In a direct message that is the thread's own session, not the one that wrote the reply. A reply the person types in that thread goes to the same place.
- **The usage summary is not the last message.** Slack posts it in the thread under the reply, so the buttons stay under the reply itself.

### Verification on Slack

A local daemon built from this change, on the model the deployment uses by default, on a real Slack workspace:

- Asked in a direct message for a short leave email, the agent replied with the draft and one button, "語氣正式一點".
- A tap on it replaced the button with a line naming the person and the line, started a run whose message was "語氣正式一點", and the agent replied with a more formal draft and a new button, "再簡短一點". Slack accepted the update that sends the message's stored blocks back with the context line in place of the buttons.
- Asked inside a thread, where the reply is created by Slack's streaming API, for three opening lines for a meeting, the reply carried two buttons.

After that check three things were added: the buttons become a line saying who tapped what, instead of vanishing; a subagent is told its answer ends without suggested replies; and a tap gets no acknowledging reaction, since its message has no Slack timestamp.

## The owner's decision on the criterion (2026-11-23)

Asked whether the one model above the unwanted-suggestion criterion should hold the section back, the owner left the decision to the maintainer and named the two models that changes are judged on from now on: `gpt-6.2-sol` and `claude-opus-5-5`. The section stays as shipped: the model above the criterion is not one of the two, and its mistake is a follow-up button after an explanation, not a guessed answer.

On the held-out messages, thirty runs a cell, `gpt-6.2-sol` gave a wanted suggestion on 30 of 30 and an unwanted one on 0 of 30, never more than two lines. `claude-opus-5-5` could not be measured: every request failed at the gateway used for the eval, whose credential for that provider had expired. It is measured when that route works again.

## Telegram (2026-11-22)

The recommendation above named a one-time reply keyboard for Telegram. Reading the adapter and probing the Bot API with a test bot overturned it:

| Question                                                                 | Answer                                                                                                         | Source                                                                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Can the final write carry a reply keyboard?                              | No. The adapter posts a message and edits it; `editMessageText` accepts only an inline keyboard.               | `@grammyjs/types` `methods.d.ts`; `editMessageText` with `rich_message` and an inline keyboard succeeded |
| Would a reply keyboard's tap reach mikan in a group?                     | No. The tap sends the bare line, and a group message that does not mention the bot is not addressed to it.     | `isAddressedToMessagingBot`                                                                              |
| Does a rich message accept an inline keyboard when sent and when edited? | Yes, both.                                                                                                     | Probe: `sendRichMessage` and `editMessageText` returned the keyboard                                     |
| How long can a button's label be?                                        | 128 characters; a longer one is accepted and cut to 128 without an error.                                      | Probe with 64, 200, 500, and 2,000 characters                                                            |
| How much can `callback_data` hold?                                       | 64 bytes; 65 is refused with `BUTTON_DATA_INVALID`.                                                            | Probe                                                                                                    |
| Does a tap say which session the reply belongs to?                       | No. In a group the session is named by the message that started it, which the reply's message does not record. | `resolveChatSessionKey`                                                                                  |

Chosen: an inline keyboard with one row per suggestion. The label is the line, so a line over 128 characters gets no button. `callback_data` is `suggested_reply:<n>:<thread part of the session key>`; the tap's text is read back from the tapped button's label, and its session from the data. When the thread part does not fit in 64 bytes, as for a scheduled event's session, the reply has no buttons.

| Candidate                                                 | Why not                                                                                                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Reply keyboard                                            | Cannot be set by an edit; its tap is not addressed to the bot in a group; it stays under the input field after the conversation moves on. |
| The line in `callback_data`                               | 64 bytes hold about twenty CJK characters.                                                                                                |
| Find the session by the reply's message ID in `log.jsonl` | A file scan per tap and a second source for the session, where the button can carry it.                                                   |
| A map of sent keyboards kept in memory                    | Lost on restart; state the button can carry.                                                                                              |

Acceptance eval (`.workspace/telegram-suggestions-eval`), the Telegram bot with a recording client:

| Case                                       | Before                              | After (as expected)                                                                               |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Private chat, reply with two lines         | text without the lines, no keyboard | the same text with two buttons                                                                    |
| Reply without lines                        | payload `6cec76c19ab4`              | identical payload                                                                                 |
| Tap in a private chat                      | no handler                          | the tapper's message with the line, in the chat's session; buttons replaced by one naming the tap |
| Tap by another person in a group           | no handler                          | that person's message, in the session of the run that wrote the reply                             |
| Tap on the button that names the tap       | no handler                          | answered, nothing starts                                                                          |
| A line of 129 characters and a short one   | no keyboard                         | one button, for the short line                                                                    |
| Session whose thread part exceeds 64 bytes | text, no keyboard                   | unchanged                                                                                         |
| System prompt                              | no section                          | Telegram gains it (rest identical, `dbb9adc77c18`); Discord identical                             |

On a real Telegram private chat, with a local daemon: a request for a leave email drew a draft with two buttons; a tap sent its line and was answered with a formal version and two new buttons, and a tap there was answered again, all three runs in the chat's one session.

The decision is [ADR 0034](../adr/0034-suggested-replies.md).
