# Harness Web Host

`src/web/harness/` is the daemon-side application service for the full Harness Web Client. It is not a portal adapter: it owns authenticated Web Conversations, projects durable Harness sessions, accepts user intents, and publishes ordered run events. The existing `/session`, `/admin`, and `/link` portals remain outside this module.

## Host/client seam

The browser sees one typed contract from `packages/harness-web-contract/`:

- `bootstrap` returns the authenticated principal, owned Conversation summaries, an optional selected transcript, available models, and a replay cursor.
- `HarnessCommand` is the object-rooted command union for create, prompt, exact-run cancel, and model selection.
- `HarnessEventEnvelope` carries one principal-scoped epoch and sequence.

HTTP is only an adapter over that contract. `GET /api/harness/bootstrap`, `POST /api/harness/command`, and `GET /api/harness/events` currently use JSON plus SSE. The browser runtime also has an in-memory port in tests; React does not know endpoint paths or cookie rules.

## Conversation ownership

Every website conversation is a first-class Conversation office with `platform = "web"`. `conversation-id.ts` creates the raw Web conversation id from:

1. a random conversation nonce; and
2. an HMAC owner digest of the immutable OAuth principal id.

The nonce comes first, so the browser-visible OfficeKey readable prefix contains no stable owner digest. The HMAC key is stored as private State-dir file `web-harness.key`. The Office registry remains the durable inventory. Authorization enumerates only records whose owner digest matches the current principal; host paths and ownership material never cross the browser seam. If the key disappears while Web offices exist, startup fails closed instead of silently orphaning or widening them.

One UI Conversation maps to one Office and its current durable `SessionHeader.id`. Commands carry both office key and full session UUID. A reset or stale tab therefore cannot write into a replacement session accidentally.

## Runtime reuse

`MikanHarnessHost` does not implement another agent loop. It creates a synthetic `web` `ConversationEvent`, `ConversationContext`, `MessagingBot`, and `ConversationResponder`, then re-enters the process-wide `ConversationRuntime`. The existing runtime retains queueing, runner caching, settings coherence, instrumentation, Harness persistence, tools, extensions, sandbox projection, and cancellation. Synthetic Web events mark slash-prefixed text as literal prompts, so a browser user cannot invoke chat capability commands (`/admin`, `/login`, `/session`) through the composer.

The web responder translates the shared response lifecycle into browser events. Final user and assistant messages still persist through `MikanAgentSession`; live deltas are ephemeral projections.

## Event order and resume

`HarnessEventJournal` maintains an independent sequence per OAuth principal and one process epoch. Bootstrap captures a cursor before projection so events racing with snapshot construction remain replayable. SSE reconnects with `Last-Event-ID`; duplicate envelopes are ignored by the client. An old epoch, future sequence, or cursor older than the ring buffer produces `reset`, causing an authoritative bootstrap instead of guessing missing state.

Run events carry office key, full session UUID, and host-issued run id. Cancel succeeds only when all three still match the active run. Command ids are idempotent per principal and cannot be reused with different input.

## Authentication

GitHub OAuth resolves the immutable numeric account id as the principal; the mutable login is display metadata only. A user must first complete `/login web` from a private platform conversation. Completed admission bindings persist in `web-bindings.json`, while pending six-character proof codes and 24-hour browser sessions remain in memory.

The cookie authenticates only the Harness Web Client. It never grants Admin or vault authority and is never converted into a Session View capability.

## Files

- `host.ts`: application service, command idempotency, session/run guards, model changes.
- `conversation-id.ts`: Web conversation-id grammar and ownership key.
- `journal.ts`: ordered principal-scoped replay journal.
- `adapter.ts`: synthetic Web messaging/responder adapter into `ConversationRuntime`.
- `transcript.ts`: durable SessionStore-to-browser projection.
- `http.ts`: cookie-authenticated JSON/SSE transport adapter.
- `types.ts`: host interfaces and option bags.
