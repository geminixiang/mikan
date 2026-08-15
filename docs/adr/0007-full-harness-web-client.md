---
status: accepted
---

# The website is a full Harness client, not a portal shell

The first React website treated `/session`, `/admin`, and `/link` as pages inside one `AppFrame`. GitHub cookie identity discovered a bound platform office, minted a Session View bearer token, and handed that token back to the React page. This preserved capability checks, but it made the website a presentation wrapper over three unrelated portal products. It had no browser-owned Conversation model, composer authority, run identity, reconnect protocol, or direct Harness seam.

DeepSeek Harness demonstrates the relevant boundary: its Web product is a client of the daemon application, while generic HTTP hosting and limited-purpose links are separate surfaces. Mikan should copy that separation without copying Cordis, dynamic package loading, or a slot/plugin system that a fixed first-party UI does not yet earn.

## Decision

Mikan ships two independent Web product classes:

1. `/session`, `/admin`, and `/link` remain server-rendered bearer-capability portals for links delivered through chat platforms. Their prefixes are reserved before the SPA fallback. Their tokens never become website identity.
2. `/`, `/login`, and `/conversations/:officeKey` form a complete authenticated Harness Web Client with Conversation creation, transcript loading, prompt streaming, exact-run cancellation, and per-Conversation model controls.

The daemon/browser seam is the typed contract in `packages/harness-web-contract/`: bootstrap, an object-rooted command union, and ordered event envelopes. Production uses JSON commands plus cookie-authenticated SSE; browser-runtime tests use an in-memory adapter. React depends on the port, not endpoint URLs or capability tokens.

## User flow

- The user first proves deployment membership through `/login web` in a private chat and binds an immutable GitHub account id.
- GitHub login issues a 24-hour in-memory browser session.
- An empty account creates a New Conversation. Each website Conversation is a first-class `platform = "web"` Conversation office, not a Session View of a Slack/Discord/Telegram office.
- Opening the Conversation loads its current durable Harness session. Prompt and model commands repeat the office key and full `SessionHeader.id`; cancel also repeats a host-issued run id.
- The daemon streams ordered deltas and run/tool diagnostics. Refresh reconstructs from the SessionStore; reconnect resumes by epoch/sequence or explicitly resnapshots.
- Logout revokes only the browser session. Admin, vault, and shareable Session View links retain their own authority.

## Conversation ownership

A Web conversation id contains a random nonce followed by a keyed digest of the immutable OAuth principal. The private State-dir HMAC key and the Office registry jointly provide ownership without exposing a stable owner digest through the browser-visible OfficeKey prefix or adding a second Conversation inventory. Losing the key while Web offices exist fails startup closed.

The private-chat binding is an admission ledger, not office authorization. Completed bindings persist so restart does not force another admission ceremony; pending proof codes and browser sessions remain ephemeral.

## Runtime and state ownership

`MikanHarnessHost` re-enters the existing `ConversationRuntime` through a synthetic Web `ConversationEvent`, `MessagingBot`, and `ConversationResponder`. It does not instantiate a parallel agent loop. Runtime serialization, runner caching, SessionStore persistence, settings coherence, tools, extensions, sandbox projection, and observability remain shared with chat platforms. The synthetic event explicitly treats leading slash text as literal agent input, so browser prompts cannot invoke chat-only capability commands such as `/admin`, `/login`, or `/session`; website controls cross only the typed Harness command seam.

The daemon owns offices, transcripts, run state, model selection, event order, and command idempotency. The browser owns route selection, drafts, connection presentation, and temporary live-response projection. Streamed text is replaced by the authoritative persisted transcript after settlement.

## Rejected alternatives

### Keep the portal-composing SPA

This minimizes backend work but permanently couples website identity to Session View bearer tokens, gives the shell no coherent run lifecycle, and lets Admin/vault presentation leak into the chat client product.

### Copy the full DeepSeek Harness plugin graph

Boot manifests, Cordis services, dynamic frontend packages, slot registries, and custom HMR are useful when independent feature bundles exist. Mikan currently has one fixed product-owned bundle, so normal Vite imports provide better locality and less machinery. A plugin seam may be reconsidered only after a second real code-source adapter exists.

### Build a second browser-specific agent runner

This would duplicate queueing, cancellation, settings invalidation, session persistence, extension activation, and sandbox policy. A synthetic adapter into `ConversationRuntime` keeps one execution authority.

## Consequences

- `PlatformName` and Office key validation include `web`.
- Website conversations receive normal Office isolation and persistent Harness sessions.
- The browser protocol has explicit version-sensitive wire types and replay behavior that must remain backward compatible within a deployed frontend/backend pair.
- The old `ui-session`, `ui-admin`, `ui-vault`, `web-bundle`, boot-manifest, and daemon-web-bridge packages are removed.
- The Vite dist is embedded in the published npm artifact; generic `web-host` owns only route dispatch and static fallback.
- This ADR supersedes ADR 0006 only where that document described `web-bundle` as the current web-composition reference or paused the full website. Its thin-core/plugin criterion remains accepted.
