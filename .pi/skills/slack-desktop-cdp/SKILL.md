---
name: slack-desktop-cdp
description: Driving the Slack macOS desktop app over the Chrome DevTools Protocol to test mikan's Slack surfaces end to end. Use when a Slack behaviour has to be exercised in a real client — agent pane, suggested prompts, streaming, long-message handling — rather than asserted in a unit test.
license: MIT
---

# Driving the Slack desktop app over CDP

Slack for macOS is Electron, so it accepts `--remote-debugging-port` and speaks
the Chrome DevTools Protocol. That makes it scriptable: read the rendered DOM,
click real controls, type into the composer. Useful when the question is "what
does a person actually see", which no unit test answers.

`cdp.mjs` in this directory is the driver. It is dependency-free on purpose —
CDP is HTTP plus a WebSocket and Node has both. Do not replace it with a
third-party "Electron MCP": that means handing unaudited code full control of a
logged-in Slack session, which is a far worse trade than this file.

## Opening and closing the port

```bash
osascript -e 'quit app "Slack"'
open -a Slack --args --remote-debugging-port=9333
curl -s http://127.0.0.1:9333/json/version    # confirm it is listening
```

**State the cost to the user before doing this, and confirm.** While the port
is open, any local process can drive their Slack and read the session. It binds
to loopback, which is the only thing limiting it. Closing it means restarting
Slack normally — say so when you finish, because nothing else will.

## Hard-won lessons

### 1. Ground truth is on disk, not in the DOM

The most expensive mistake available here is treating the DOM as evidence.
Slack's message list is virtualised: items are recycled on scroll, DOM order is
not visual order, and counts change under you. Several rounds of "is the reply
there?" produced nothing; two files answered it immediately.

For a mikan conversation at `<state-dir>/workspace/<conversation-id>/`:

| File               | Holds                                              |
| ------------------ | -------------------------------------------------- |
| `log.jsonl`        | what mikan actually sent to the platform           |
| `sessions/*.jsonl` | the raw model turn, before any platform truncation |

Diffing those two is the single highest-value move in this whole workflow. It
found real data loss — a reply the model produced as 152 lines reached Slack as
53, with the rest silently dropped behind a notice that claimed otherwise.
Neither number was visible in the UI.

Use the DOM for what only the DOM knows: whether something _rendered_.

### 2. mikan logs to stdout, so plan for having no log

There is no log file under the state directory. If mikan was started in someone
else's terminal you cannot read its output, and you will not be able to confirm
"did the event arrive". Either ask them to paste it, or design the check so
disk state answers it instead.

### 3. The human is using this Slack too

The view changes under you mid-command. During one run the user switched
workspaces between "decide to send" and "send" — the message would have gone
into an unrelated private DM.

`send` therefore refuses unless `CDP_EXPECT_CONVERSATION` is set and appears in
the current URL. Never remove that check. Also expect to read things you should
not: if you land in someone's private conversation, do not quote or retain it,
and say so.

### 4. `element.click()` is not always a function

Slack renders many controls as `<svg>` inside a `[role=button]` wrapper, and
`SVGElement` has no `.click()`. Walk up to the nearest node that does — the
driver's `click` command already handles this. Selecting by `data-qa` often
lands on the icon, not the control.

Never click by screen coordinates. An earlier attempt did, and hit Chrome
because the user changed the frontmost app; the method was wrong, not unlucky.

### 5. The composer is Quill — use the Input domain

Writing `textContent` or dispatching a hand-built `KeyboardEvent` does nothing;
Quill reconciles its own model from real input. Send `Input.insertText`, then
`Input.dispatchKeyEvent` for Enter, and verify the composer is empty afterwards
so a silent failure does not look like a send.

### 6. A full reload loses deep links

Setting `location.href` to a thread URL reloads the whole SPA and Slack drops
the thread path, landing on the channel. Navigate by clicking sidebar and
message controls instead.

### 7. `data-qa` is the stable-ish handle

Class names are hashed (`toggleAndLabel__g8Gk4`) and change between releases;
`data-qa` attributes survive longer. Useful ones seen in the client: `ai-agents`
(the sidebar Apps section icon, _not_ an agent rail), `move-to-split-view`,
`message_pane`, `virtual-list-item`, `threads_flexpane`, `quick-switch`.

Treat all of them as observations, not API. Re-probe rather than trusting this
list:

```bash
node cdp.mjs eval '[...new Set([...document.querySelectorAll("[data-qa]")].map(el => el.getAttribute("data-qa")))]'
```

### 8. Slash commands cannot be sent, but a leading space gets around it

Slack's composer refuses a synthetic Enter on anything starting with `/` —
registered command or not, menu open or dismissed. Plain text sends fine
through the same key events, so this is Slack validating the command path
rather than the driver failing.

Send `" /pm status"` with a leading space instead. Slack treats it as an
ordinary message, and mikan trims before parsing on both command paths
(`parseCommandInput` and `matchCommand`), so the command still runs.

Typing `/pm` also fuzzy-matches unrelated entries — the menu offered
`/pi-model` — so what the menu shows is no evidence the command exists.

### 9. `conversations.history` does not contain thread replies

Two mikan replies that look missing are simply threaded:

- **Diagnostic output** (`replyDiagnosticWithContext`, `style: "muted"`) — how
  `/pi-extensions` and friends answer.
- **The continuation** of a message too long for one Slack message.

Both had me conclude "no reply" from a clean `conversations.history` read.
Fetch `conversations.replies` on the triggering message before believing a
command produced nothing.

### 10. Suggested prompts may simply not render

A DOM search finding no prompt elements does not prove mikan failed to call
`assistant.threads.setSuggestedPrompts`. Slack shows prompts on an empty
conversation; in a DM with history there may be nothing to see either way. This
question stayed unresolved because it was approached only through the DOM —
without mikan's stdout there was no second source. Do not report it as a
verdict in either direction.

## Worked example: the long-response test

The test that found real breakage, start to finish:

1. Ask for output long enough to exceed the platform's limits, and made of
   countable, ordered lines so loss is measurable:
   `"output 320 lines, each NNN | <fixed 40-char body>, numbered 001 upward"`.
   Do not ask for prose — you cannot tell truncation from brevity.
2. Poll until the run settles. mikan's own status text (`代理正在評估…`) marks
   it as working; its disappearance marks the end.
3. Compare `sessions/*.jsonl` (152 lines produced) against `log.jsonl`
   (53 lines delivered).
4. Reach for the code only once the gap is measured.

Expect the model to stop short of large exact counts on its own — that is
laziness, not truncation, and the line numbers distinguish them.

## Checklist

Before:

- [ ] User has confirmed opening a debug port, knowing any local process can
      then drive their Slack.
- [ ] `CDP_EXPECT_CONVERSATION` set to the intended conversation.

During:

- [ ] Prefer disk evidence over DOM evidence for anything about content.
- [ ] Re-read `location.href` before acting on a stale assumption about view.

After:

- [ ] Tell the user to restart Slack normally to close the port.
