# poll — interactive Block Kit extension example

The driving example for `api.blockkit`: a Slack poll where creating, voting,
and closing never call the model.

## What it demonstrates

- **`registerCommand`** — `/poll 問題 | 選項A | 選項B` builds the poll
  deterministically (no agent run).
- **`api.blockkit.post`** — posts the interactive message. Every `action_id`
  is automatically namespaced `ext:<slug>:…`, so clicks route to this
  extension exclusively.
- **`api.blockkit.onAction`** — vote clicks land in plain handlers: read the
  tally from `api.paths.dataDir`, count exactly (one vote per user,
  re-voting overwrites), and…
- **`api.blockkit.update`** — …rewrite the message in place: live tally on
  every vote, and on close the buttons are retired so stale clicks hit
  nothing.
- **LLM by choice** — nothing here calls the model. A handler that wanted it
  (e.g. "summarize the result") would call `api.triggerRun(...)` itself.

## Install

```bash
mikan ext install deploy/examples/extensions/poll --global
# or scope to one conversation:
mikan ext install deploy/examples/extensions/poll --conversation C0123456789
```

Then send `/pi-new` in each affected conversation — that builds a fresh harness
instance, which is what loads extensions. No mikan restart is required (each
load uses a fresh jiti instance with no module cache). In the conversation:

```
/poll 晚餐吃什麼 | 拉麵 | 披薩 | 便當
```

Slack only: `api.blockkit` needs a platform that provides Block Kit messaging,
and Slack is the one adapter that does today. On other platforms the calls
throw rather than degrading, so this example has nothing to fall back to.
(`mikan ext dev` provides no Block Kit backend either — the dev loop is
stdin/stdout, so use it for extensions built on tools, hooks, and commands.)
