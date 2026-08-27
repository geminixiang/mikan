# embedder

The smallest possible mikan embedder: a stdin/stdout chat agent built
entirely from the public npm surface of `@geminixiang/mikan` (`src/index.ts`).
It exists to prove — and keep proving — that the harness is usable outside
mikan's own `main.ts`:

- `createConversationRuntime({ workspace, sandbox: { type: "host" } })` with
  **no** vault manager and **no** portal token stores. Those services are
  optional; the runtime falls back to a disabled vault and portal commands
  reply "not configured".
- `workspace` is a `Workspace` value built by `createWorkspace({ root, stateDir })`.
  An embedder owns both roots: the workspace the agent works in, and the
  host-only state dir mikan keeps its office registry and settings under.
- A minimal `MessagingBot` and `ConversationResponder` that print to stdout.
- Each stdin line is wrapped in a `ConversationEvent` and fed through
  `runtime.handleEvent`, so sessions, commands (`/new`, `/model`, …), and the
  agent loop all work as they do on Slack/Discord/Telegram/GitHub.

An office is identified by its platform plus its raw conversation id, so an
embedder adopts one of mikan's supported platforms; this example drives a
`slack` office over stdin/stdout instead of Socket Mode.

## Run it

Requires a configured mikan state dir: `~/.mikan` with `settings.json` (required)
(`models.json` is optional). `MIKAN_STATE_DIR` (or `STATE_DIR`)
moves where `settings.json` is read from; `models.json` stays
under `~/.mikan` unless you construct your own `MikanModels` with explicit paths
and pass it as the `models` option — which is what the test does.

```sh
npx tsx deploy/examples/embedder/index.ts
```

Type a message, get a reply. Invoked directly, the workspace root is the
current directory and the state dir defaults to `state` beside it.
Conversation state lands in one office directory per conversation under the
workspace root, named by office key (`v1-<platform>-<readable-id>-<digest>`).

## Typecheck it

The example imports the package by name; `tsconfig.json` maps
`@geminixiang/mikan` to `../../../src/index.ts` so it typechecks in-repo
against the real export surface:

```sh
npx tsgo -p deploy/examples/embedder/tsconfig.json
```

This is a manual gate — CI does not run it.

`src/test/embedder-example.test.ts` does run in CI: it imports `createEmbedder`
and drives a full stdin-line → agent-reply round trip against a faux model
provider, so the suite fails if the public surface stops being sufficient for
an embedder at runtime.
