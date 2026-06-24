---
title: Portal auth and capability model
---

# Portal auth and capability model

This document describes the current web surfaces in mikan and the token model they use. It is intentionally descriptive: it records the behavior that exists in code today so future dashboard/refactor work can preserve the right risk boundaries.

## Web surfaces

mikan currently exposes three related but different browser surfaces from the link server started in `src/login/portal.ts` via `startLinkServer()`:

| Surface              | Primary routes                                                       | Command entry                                                          | Purpose                                                                                                  | Risk level  | Token store                                           |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| Admin portal         | `/admin`, `/admin/api/*`                                             | `/admin` / `/pi-admin`                                                 | Manage conversations, settings, workspace previews, skills, events, and generate session/login links.    | Medium-high | `InMemoryAdminTokenStore`                             |
| Login / vault portal | `/link`, `/api/link/complete`, `/api/oauth/start`, `/oauth/callback` | `/login` / `/pi-login` or admin-generated login link                   | Store API keys and OAuth credentials in a vault.                                                         | Highest     | `InMemoryLinkTokenStore` plus short-lived OAuth state |
| Session view         | `/session`, `/session/stream`, `/session/message`                    | `session` / `/session` / `/pi-session` or admin-generated session link | View a session timeline and, when interactive wiring is available, send messages back into that session. | Medium      | `InMemorySessionViewTokenStore`                       |

The three surfaces share visual chrome through `src/portal-shell.ts`, but they intentionally do not share the same authorization token.

## Server ownership today

`src/login/portal.ts` currently owns the HTTP server even though it also contains login/vault-specific code. The dispatch order is:

1. `GET /health`
2. Admin routes via `handleAdminRequest()` when an admin token store is configured
3. Session view routes via `handleSessionViewRequest()`
4. Login/vault routes (`/link`, `/api/link/complete`, `/api/oauth/start`, `/oauth/callback`)
5. `404`

This means the module name is narrower than its actual responsibility: it is both the link/login portal and the portal host.

The server is started only when `LINK_PORT` (or `MIKAN_LINK_PORT` through `readEnv`) resolves to a port in `src/main.ts`. If `LINK_URL` / `MIKAN_LINK_URL` is set and no explicit port is set, mikan defaults to port `8181`.

## Token types

### Admin token

Defined in `src/admin/store.ts` as `AdminToken` and stored by `InMemoryAdminTokenStore`.

Current properties:

- `token`
- `platform`
- `platformUserId`
- optional `platformUserName`
- `conversationId`
- `expiresAt`

Current behavior:

- TTL: 30 minutes.
- Lookup method: `peek(rawToken)`.
- Not consumed on use.
- Creating a new admin token for the same `(platform, platformUserId)` invalidates that user's prior admin token.
- Used by `/admin` and every `/admin/api/*` route.

Current capability:

- Read admin page identity (`/admin/api/me`).
- List conversations from the configured working directory.
- Read/update conversation model, thinking level, sandbox mount, and auto-reply settings.
- Read/update global model and sandbox defaults.
- Read limited conversation workspace files under exposed paths.
- Read skills and events metadata/files.
- Delete events associated with the selected conversation.
- Generate session view links and login/vault links for a target conversation.

Important boundary:

- The admin token can generate a login link, but it does not itself write secret values into a vault. Secret writes still go through the login/vault token flow.

### Login / link token

Defined in `src/login/session.ts` as `LinkToken` and stored by `InMemoryLinkTokenStore`.

Current properties:

- `token`
- `platform`
- `platformUserId`
- `vaultId`
- `providerId`
- `conversationId`
- `expiresAt`

Current behavior:

- TTL: 15 minutes.
- Lookup method: `peek(rawToken)` for rendering `/link` and starting OAuth.
- Consume method: `consume(rawToken)` for credential completion and OAuth callback.
- Creating a new link token for the same `(platform, platformUserId)` invalidates that user's prior link token.
- `/api/link/complete` consumes the token before writing credentials.
- `/oauth/callback` consumes the token after validating and spending the OAuth state.

Current capability:

- Render a credential/OAuth onboarding form for a specific vault.
- Write environment variables and selected file mounts into that vault.
- Complete supported OAuth flows and persist tokens/credential files.
- Notify the originating conversation after successful credential storage.

Additional protections:

- Credential POST routes require `Content-Type: application/json`.
- When `LINK_URL` / `MIKAN_LINK_URL` is configured, credential POST routes enforce same-origin `Origin` or `Referer`.
- OAuth uses a separate in-memory state with a 10 minute TTL and PKCE verifier.
- Secret values are not rendered back to the browser; existing vault summaries show secret names and mount targets only.

Important boundary:

- A link token is a high-risk action capability, not a general dashboard session. It should remain short-lived and one-shot for writes.

### Session view token

Defined in `src/session-view/store.ts` as `SessionViewToken` and stored by `InMemorySessionViewTokenStore`.

Current properties:

- `token`
- `platform`
- `platformUserId`
- optional `platformUserName`
- `conversationId`
- `sessionKey`
- `sessionFile`
- `expiresAt`

Current behavior:

- TTL: 24 hours.
- Lookup method: `peek(rawToken)`.
- Not consumed on use.
- Used by `/session`, `/session/stream`, and `/session/message`.
- A token is anchored to a base session file, but `/session?session=<file.jsonl>` may navigate to related session files in the same directory after validation.

Current capability:

- Render a session timeline from a structured session file.
- Navigate parent/thread session relationships.
- Subscribe to live status/timeline updates over SSE.
- Send a message into the selected session when `SessionViewInteractiveOptions` is configured.

Important boundary:

- Session view is not purely read-only in current code because `/session/message` can call `handler.handleEvent()` with a `session_view` event. User-facing copy should avoid calling it read-only unless that route is disabled or removed.

## Route-to-token matrix

| Route                | Method | Token source      | Store / state                            | Notes                                                                                      |
| -------------------- | ------ | ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `/admin`             | `GET`  | query `token`     | `adminTokenStore.peek()`                 | Renders admin portal or 403 error page.                                                    |
| `/admin/api/*`       | `GET`  | query `token`     | `adminTokenStore.peek()`                 | Returns JSON; unauthorized returns 403.                                                    |
| `/admin/api/*`       | `POST` | JSON body `token` | `adminTokenStore.peek()`                 | Returns JSON; unauthorized returns 403.                                                    |
| `/link`              | `GET`  | query `token`     | `linkTokenStore.peek()`                  | Renders login/vault page; does not consume.                                                |
| `/api/link/complete` | `POST` | JSON body `token` | `linkTokenStore.consume()`               | Writes credentials; protected by JSON content type and same-origin checks when configured. |
| `/api/oauth/start`   | `POST` | JSON body `token` | `linkTokenStore.peek()` + OAuth state    | Starts OAuth; does not consume link token yet.                                             |
| `/oauth/callback`    | `GET`  | query `state`     | OAuth state + `linkTokenStore.consume()` | Spends OAuth state and link token.                                                         |
| `/session`           | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | Renders session page.                                                                      |
| `/session/stream`    | `GET`  | query `token`     | `sessionViewTokenStore.peek()`           | Opens SSE stream; requires interactive wiring.                                             |
| `/session/message`   | `POST` | JSON body `token` | `sessionViewTokenStore.peek()`           | Sends a `session_view` event; requires interactive wiring.                                 |

## Why the tokens should not be flattened

The current differences are intentional risk controls:

- Admin token: medium-high control-plane access; reusable within a short session window.
- Link token: highest-risk secret-write action; short-lived and consumed on write/callback.
- Session view token: medium-risk session content/action access; longer-lived for user convenience.

A future dashboard can introduce a higher-level portal identity, but it should not erase these boundaries. In particular:

- Dashboard access may authorize viewing/settings operations.
- Secret writes should still require a short-lived action capability or an equivalent second step.
- Standalone session links can remain capability links even if dashboard-native session viewing is added.

## Known alignment notes

- `commands.md` should describe `session` as a web session view, not strictly read-only, while `/session/message` exists.
- `src/login/portal.ts` is broader than its name: it hosts admin, session view, and login routes.
- `src/portal-shell.ts` is shared presentation only; it is not an auth boundary.
- Token stores are in-memory and are purged every five minutes from `src/main.ts`; restarting the process invalidates all outstanding web tokens.
