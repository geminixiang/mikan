# embedder

The smallest possible mikan embedder: a stdin/stdout chat agent built
entirely from the public npm surface of `@geminixiang/mikan` (`src/index.ts`).
It exists to prove — and keep proving — that the harness is usable outside
mikan's own `main.ts`:

- `createConversationRuntime({ workingDir, sandbox: { type: "host" } })` with
  **no** vault manager and **no** portal token stores. Those services are
  optional; the runtime falls back to a disabled vault and portal commands
  reply "not configured".
- A minimal `MessagingBot` and `ConversationResponder` that print to stdout.
- Each stdin line is wrapped in a `ConversationEvent` and fed through
  `runtime.handleEvent`, so sessions, commands (`/new`, `/model`, …), and the
  agent loop all work as they do on Slack/Discord/Telegram/GitHub.

## Run it

Requires a configured mikan state dir (`~/.mikan` with `auth.json` and
`settings.json`, or `MIKAN_STATE_DIR` pointing at one):

```sh
npx tsx examples/embedder/index.ts
```

Type a message, get a reply. Conversation state lands under the working
directory (one subdirectory per conversation id).

## Typecheck it

The example imports the package by name; `tsconfig.json` maps
`@geminixiang/mikan` to `../../src/index.ts` so it typechecks in-repo against
the real export surface:

```sh
npx tsgo -p examples/embedder/tsconfig.json --noEmit
```

`test/embedder-example.test.ts` also imports `createEmbedder` and runs a full
stdin-line → agent-reply round trip against a faux model provider, so CI
fails if the public surface stops being sufficient for an embedder.
