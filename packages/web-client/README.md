# Harness Web Client

This package is the full interactive browser client for mikan. It owns login presentation, Conversation selection, drafts, live response projection, reconnect state, model controls, and the composer. It never imports or mounts the Session View, Admin, or credential-link portals.

## Runtime

`HarnessClient` is React-free. The UI subscribes with `useSyncExternalStore` and sends intents through its action methods. Its only daemon dependency is `HarnessHostPort`:

- `HttpHarnessHostPort` is the production JSON/SSE adapter.
- tests provide an in-memory adapter against the same interface.

The runtime folds strictly ordered `HarnessEventEnvelope` values into the selected Conversation. Duplicate sequences are ignored; gaps and server resets trigger a new bootstrap. After a run settles, the runtime reloads the persisted transcript so the durable SessionStore—not streamed browser text—remains authoritative.

## State ownership

The daemon owns Conversation offices, durable session UUIDs, transcripts, active runs, models, and event order. The browser owns the selected office, draft text, connection indicator, and temporary live-response nodes. A route is only a selection hint; every mutating command repeats the daemon-issued office/session/run identities.

## Composition

The app has a fixed first-party feature roster and uses normal Vite imports. There is no boot manifest, plugin graph, slot registry, custom module loader, or production HMR protocol. Add such a seam only after a second real code-source adapter exists.

Routes owned by this client are `/`, `/login`, and `/conversations/:officeKey`. Daemon route registration always claims `/session`, `/admin`, and `/link` before the static fallback.
