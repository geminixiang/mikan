# scheduled-counter

The golden-path mikan extension: the smallest program that exercises all
three core surfaces — a chat command, a callback schedule, and durable
per-conversation state. Start here; graduate to `poll` (Block Kit
interactions) and `agent-pm` (cross-conversation application) when you need
their patterns.

```
scheduled-counter/
├── package.json   # entrypoint + mikan.requires capability declaration
├── index.ts       # activate(api): command + schedule + state
└── README.md
```

## Run it

No platform, no install — a local stdin/stdout conversation:

```sh
mikan ext dev deploy/examples/extensions/scheduled-counter
```

Then type `/counter` a few times. Install for real with:

```sh
mikan ext install deploy/examples/extensions/scheduled-counter --global
```

## The multi-tenant model in one example

`activate` runs once **per conversation**, not once per process. That is
the single most important fact about writing mikan extensions:

- `api.paths.dataDir` is this conversation's own directory. Two
  conversations each count from zero; there is nothing to coordinate.
- The `daily-report` schedule is also per-conversation: every conversation
  that activates the extension gets its own 09:00 report about its own
  count. Schedule names are namespaced by extension slug _and_
  conversation, so upserting the same name everywhere is safe and idempotent.
- If you want one shared count across conversations, use
  `api.paths.sharedDataDir` — and then _you_ own the concurrency story
  (several conversations' handlers may write it).

`mikan.requires` in package.json declares the capabilities this extension
needs (`schedules.callback`, `messaging.notify`). Contexts that cannot provide
them fail activation with one clear error naming the gap. For optional
features, probe `api.capabilities.has("blockkit")` instead and degrade
gracefully.
