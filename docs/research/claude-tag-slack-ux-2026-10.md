# What makes Claude Tag feel native in Slack (2026-10)

Question: Claude Tag (`@Claude` in Slack, public beta) is described by its users as natural to work with in Slack. What does it do, and which of those behaviors does mikan already have?

Sources are Anthropic's Claude Tag documentation read on 2026-10-09 (`https://claude.com/docs/claude-tag/*`, each page also served as Markdown at `<url>.md`, indexed by `https://claude.com/docs/llms.txt`): overview, how it works, when Claude responds, routines, memory, commands, getting started, agent identity, and the Slack admin page. Nothing here was measured against the product itself; statements about how it is built are marked as inference.

## The model

| Level   | What lives there                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel | Tool access set by an admin, channel memory, and one long-lived channel session that reads top-level messages and handles top-level mentions (replaced after about an hour idle or a day) |
| Thread  | One working session per thread, with its own sandbox; anyone in the thread can steer it by replying, without mentioning Claude again                                                      |
| DM      | Runs on the person's own account and connectors; outside the channel model                                                                                                                |

A top-level mention goes to the channel session, which answers in a thread under the message or starts a thread session when the request needs tools or a longer exchange. The answer never goes to the channel's top level.

## Behaviors that make it feel native

| Behavior                           | What the user sees                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acknowledge first                  | An emoji reaction on the message within seconds, before any reply                                                                                                                                     |
| Reply in the thread                | Results, files, and charts go to the thread under the request; the channel stays a list of requests                                                                                                   |
| Working indicator and Stop         | In a channel thread a working indicator with a Stop button at the bottom of the thread; Stop keeps the session, and Claude posts who stopped it. **A DM has no Stop button** and shows "is thinking…" |
| Checklist for long tasks           | The first reply is a checklist edited in place; the docs warn that edits send no notification, so a quiet thread usually means work is in progress                                                    |
| Steer by replying                  | Any reply in a thread Claude is in reaches the running session, from anyone in the channel                                                                                                            |
| Quiet by default                   | Untagged channel messages usually get nothing; a short thread reply only when the answer is already known; a per-channel "Respond automatically" switch; it replies less in channels that ignore it   |
| Text commands that work in threads | `@Claude !status`, `!restart`, `!mute`, `!unmute`, `!fast`, `!routines`, `!fork`, `!configure`, `!help`; Slack slash commands do not run in threads                                                   |
| Thumbs-down mutes                  | Feedback buttons on replies; thumbs-down mutes that thread; a new mention unmutes it                                                                                                                  |
| Footer                             | Each reply names the model and links to the channel's settings page                                                                                                                                   |
| Memory by place                    | Channel notes, plus workspace notes saved from public channels; "remember for this channel: …" stores a standing instruction anyone in the channel can read and correct                               |
| Routines                           | Schedules, channel watches, and pull request subscriptions set up in plain language from the channel where results should post                                                                        |

The Stop button in channel threads and the "is thinking…" text in DMs match Slack's agent session UI with and without a stop subscription; that Claude Tag is built on agent sessions is inference.

## mikan against the same list

| Behavior                   | mikan 1.2.2                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Acknowledge first          | Has it: a reaction on the triggering message                                                      |
| Reply in the thread        | Configurable: `slack.replyMode` `thread`; the default `top-level` posts the answer in the channel |
| Working indicator and Stop | Thread status only; no native Stop button. mikan stops a run with the `stop` word                 |
| Checklist for long tasks   | Partly: "• step" lines that become "✓ step" inside the reply                                      |
| Steer by replying          | Partly: DM task threads steer; channel threads go through the auto-reply decision                 |
| Quiet by default           | Has it: auto-reply with Jev and `/pi-auto-reply`                                                  |
| Text commands in threads   | Only `stop`; the `/pi-*` slash commands are rejected in threads by Slack                          |
| Thumbs-down mutes          | No                                                                                                |
| Footer                     | "Triggered by" and a usage summary in the thread; no model name or settings link                  |
| Memory by place            | Has it: memory per office                                                                         |
| Routines                   | Has it: scheduled events                                                                          |

## Takeaways

- The native feel comes from a product rule more than from Slack APIs: a request is a thread, the answer stays in that thread, and anyone can continue it there. Slack's agent session features (status, Stop) attach to that rule; they do not create it.
- Claude Tag accepts the DM trade-off this research hit: no Stop button in DMs.
- Most of the behaviors already exist in mikan. The visible gaps are the default reply location, text commands inside threads, and feedback that mutes a thread.
