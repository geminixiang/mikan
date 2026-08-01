---
name: discord-desktop-cdp
description: Driving the Discord macOS desktop app over the Chrome DevTools Protocol to see how mikan's messages actually render. Use when the question is what a person sees on screen — layout, alignment, whether an edit stuck — rather than what a message contains, which the REST API answers better.
license: MIT
---

# Driving the Discord desktop app over CDP

Discord for macOS is Electron, so it accepts `--remote-debugging-port` and
speaks the Chrome DevTools Protocol. `cdp.mjs` in this directory is the driver,
dependency-free for the same reason as the Slack one: CDP is HTTP plus a
WebSocket, and a third-party "Electron MCP" would mean handing unaudited code a
logged-in Discord session.

## Use the REST API first — this is the exception, not the default

**Unlike Slack, Discord answers almost every content question through its REST
API**, and the API is both easier and strictly more precise. With the bot token
already in `~/.mikan/mikan.dev.env`:

```bash
curl -s -H "Authorization: Bot $TOKEN" \
  "https://discord.com/api/v10/channels/<id>/messages?limit=10"
```

That returns `flags`, `components`, `content`, edit state — fields the DOM does
not expose at all. Confirming Components V2 shipped (`flags: 32768`,
`components[0].type: 10`, empty `content`) was a one-line API read; no amount of
DOM scraping shows a message flag.

Reach for CDP only for **what the API cannot describe: rendering**. Two real
bugs in one session were invisible to the API and obvious in a screenshot:

- A Discord table was converted correctly during streaming and then overwritten
  with the raw source by the final replace. The API showed the raw text and
  looked like the conversion had simply never run; the `(edited)` marker on the
  message was what said otherwise.
- Aligned monospace columns that are byte-perfect in the API text still come out
  ragged, because Discord's code-block CJK fallback font is not exactly twice
  the Latin advance. The text was right and the render was wrong.

The rule that follows: **the API tells you what was sent, the screen tells you
what was received.** Do not report a rendering change as verified from API text.

## Opening and closing the port

```bash
osascript -e 'quit app "Discord"'
open -a Discord --args --remote-debugging-port=9334
curl -s http://127.0.0.1:9334/json/version    # confirm it is listening
```

9334 rather than 9333 so Slack and Discord can be driven at the same time; the
driver defaults to it and takes `CDP_PORT` to override.

**State the cost to the user before doing this, and confirm.** While the port is
open, any local process can drive their Discord and read the session. It binds
to loopback, which is the only thing limiting it. Closing it means restarting
Discord normally — say so when you finish, because nothing else will. Restarting
Discord does not disturb a running mikan job: those run server-side, and only
the person's own window closes.

## Hard-won lessons

### 1. Two Slate editors, and one of them is the search box

Discord's composer is **Slate**, not Quill — `.ql-editor` finds nothing here.
But `[data-slate-editor]` alone is a trap: the quick-switcher search box is also
a Slate editor, so a bare match can land on it, and text typed there silently
becomes a search instead of a message.

`role="textbox"` is what separates them; the search box is `role="combobox"`.
The driver's `COMPOSER` constant encodes this — do not loosen it.

### 2. Slate wants real input events

Writing `textContent` or dispatching a hand-built `KeyboardEvent` does nothing;
Slate builds its model from real input. Use `Input.insertText` then
`Input.dispatchKeyEvent` for Enter, and verify the composer is empty afterwards
so a silent failure does not read as a send. This is confirmed working — unlike
Slack, where the composer refuses a synthetic Enter on anything starting with
`/`.

### 3. Clear before typing

A send that failed leaves its text in the composer, and inserting on top of it
silently doubles the message. The driver Backspaces per character first, because
Slate ignores a synthetic Cmd+A so there is no select-all to lean on.

### 4. Bind the send to a conversation

The human is using this same Discord and the view can change under you. `send`
refuses unless `CDP_EXPECT_CONVERSATION` is set and appears in the current URL —
a misdelivered message lands in a real channel and cannot be recalled. Both
refusals are verified. Never remove that check.

Discord URLs carry the id plainly: `/channels/@me/<dm-id>` for a DM,
`/channels/<guild>/<channel>` otherwise.

### 5. Useful handles

Observations, not API — re-probe rather than trusting this list:

- `[data-slate-editor="true"][role="textbox"]` — the message composer
- `[id^=chat-messages-]` — one per rendered message
- Class names are hashed (`markup__75297`) and change between releases

## Commands

```bash
node cdp.mjs eval    '<javascript expression>'
node cdp.mjs click   '<css selector>'        # element's own .click()
node cdp.mjs clickat '<exact element text>'  # real mouse events, for controls that ignore click()
node cdp.mjs text    '<css selector>'
node cdp.mjs type    '<text>'                # compose without sending
node cdp.mjs press   'Enter'
node cdp.mjs send    '<text>'                # needs CDP_EXPECT_CONVERSATION
```

## Not yet tested

Stated so nobody mistakes silence for evidence:

- **Slash commands.** Slack refuses a synthetic Enter on `/`-prefixed text and
  needs a leading-space workaround; whether Discord does the same is unknown.
- **Thread composers.** Slack replaces the channel composer with a thread's reply
  box, which sent several messages to the wrong place before it was caught.
  Discord threads are separate channels, so this may not arise — but it has not
  been checked.
- **`clickat` on Discord controls.** It works on Slack's Block Kit buttons; the
  same need has not come up here.

## Checklist

Before:

- [ ] The question genuinely needs rendering — otherwise use the REST API.
- [ ] User has confirmed opening a debug port, knowing any local process can
      then drive their Discord.
- [ ] `CDP_EXPECT_CONVERSATION` set to the intended channel.

After:

- [ ] Tell the user to restart Discord normally to close the port.
