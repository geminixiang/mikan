# `slack_blockkit` for buttons and menus only (2026-11)

The refactor scope keeps `slack_blockkit` only for interactive elements. The owner added two constraints on 2026-11-22: the automatic Markdown to Block Kit conversion is what people use every day and must not change, and the tool itself can shrink to what Markdown cannot express.

## What existed

`slack_blockkit { blocks, text, thread_ts?, update_ts? }` took arbitrary Block Kit JSON. Its description and the prompt said to use it only for interactive elements, and nothing enforced that. The conversion every ordinary reply goes through is `renderSlackBlocks` in `src/adapters/slack/blocks.ts`: prose to `markdown` blocks, pipe tables to `table` blocks, a plain-text fallback, and Slack's limits.

## How it was used

Read from a deployment's logs over a month, without content. Calls were few. About two in three had no interactive element at all: they were tables and prose, which a normal reply renders. The interactive ones used buttons in an `actions` block; no select menu, date picker, checkbox, or radio button appeared. About one call in seven was rejected by Slack for malformed blocks. A second reading parsed each call's whole arguments and confirmed it: every interactive call used buttons and nothing else, between one and seven of them, beside a table and prose; a few also had `context` text, which becomes ordinary prose. No call replaced a message. Clicks were rare: on one day of the month.

## Choices

| Choice                       | Chosen                                                                   | Alternative                                                     | Reason                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| What the model gives         | Markdown `text`, plus `buttons` and/or a `menu`                          | Keep raw blocks and refuse calls without an interactive element | The model stops writing Block Kit JSON, which Slack rejected one time in seven; the text goes through the same conversion as any reply |
| Interactive elements kept    | Buttons (with `primary` and `danger`), a select menu, single or multiple | Buttons only                                                    | These are what the click handler turns into a message for the agent today; nothing that works is dropped                               |
| A call with nothing to click | Refused, with "reply normally"                                           | Post it anyway                                                  | A normal reply renders the same Markdown, streams, and takes part in the response lifecycle                                            |
| Replacing a message          | `update_ts`, and no buttons or menu removes them                         | A separate tool                                                 | Closing a question after a click is the reason messages get replaced                                                                   |
| The tool's name              | Unchanged                                                                | Rename                                                          | Session history, logs, and the prompt name it                                                                                          |
| Old-shaped calls             | Refused with what to give instead                                        | Accept `blocks` for a while                                     | A session that imitates its history learns the new shape from one error                                                                |
| `thread_ts`                  | Removed                                                                  | Keep                                                            | Posts were always confined to the run's thread; the parameter could only be wrong                                                      |

## What changes for people

- A message with buttons looks the same: the text, then the buttons. Custom layouts around them (a `section` with an accessory, `context` text) are no longer possible.
- A table the model used to post through the tool becomes a normal reply. mikan's conversion adds a `#` column to a table that has none; a table built by hand through the tool had none.
- Buttons on messages posted before the upgrade still work: the click handler is unchanged, and a message in the log with blocks can still be replaced.

## Acceptance eval

`.workspace/blockkit-narrowing-eval/blockkit.eval.ts`, baseline 224c7645.

| Case                                                | Baseline               | Expected                                | After       |
| --------------------------------------------------- | ---------------------- | --------------------------------------- | ----------- |
| Markdown to Block Kit conversion, 17 kinds of reply | `b77990023c88`         | Identical                               | Identical   |
| Text with two buttons                               | Posted from raw blocks | Posted: `markdown`, `actions` with both | As expected |
| Text with a table and a button                      | Posted from raw blocks | Posted: `table`, `markdown`, `actions`  | As expected |
| A select menu, single and multiple                  | Posted from raw blocks | `static_select`, `multi_static_select`  | As expected |
| A table or prose with nothing to click (accepted)   | Posted                 | Refused, told to reply normally         | As expected |
| Raw Block Kit JSON (accepted)                       | Posted                 | Refused, told what to give              | As expected |
| Replace own message without buttons                 | Replaced               | Replaced with the text alone            | As expected |
| Replace a message posted before the upgrade         | Replaced               | Replaced                                | As expected |
| Replace a message the tool did not post             | Refused                | Refused                                 | As expected |

`src/test/slack-markdown-conversion.test.ts` holds a snapshot of the conversion, generated on the baseline before the change. `src/test/slack-blockkit-roundtrip.test.ts` runs the whole path through the Slack bot: buttons reach Slack, a click reaches the agent as `[Slack action] button_1: yes`, and the agent replaces the message.

## Verification on Slack

A local daemon built from this change posted, on a real Slack workspace, a message with a table and two buttons through the new arguments, and a click on a button started a run with `[Slack action] button_1: <value>`.

Replacing the message afterwards could not be shown on the model lane the Slack E2E uses: that lane turns any ten-digit number into `[PHONE]`, in a plain echo too, so the model never has a Slack timestamp to pass back as `update_ts`. This is the same before the change and is a property of the lane, not of mikan; the round-trip test covers the replacement.
