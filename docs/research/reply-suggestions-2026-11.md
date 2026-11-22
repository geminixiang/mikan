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
- **Stale buttons.** They are removed when tapped; whether they are also removed when the person types instead is a choice per adapter.

## Acceptance criteria proposed for the implementation

On the same twenty messages and three models: wanted suggestions at least as often as the table above for C; unwanted suggestions on at most 1 of 20 per model; never more than two; and on a real Slack workspace a tap sends the line as the person's message and the agent answers it. The Markdown conversion snapshot stays unchanged.

## Removal condition

Ninety days after it ships, from production: if fewer than one final reply in twenty carries a suggestion, or fewer than one suggestion in twenty shown is tapped, remove the section, the parser, and the renderers. The remaining path is typing the reply.
