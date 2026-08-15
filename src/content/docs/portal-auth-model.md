---
title: Portal auth and capability model
description: Authentication and capability boundaries for the Harness Web Client and standalone portals.
---

Mikan exposes one authenticated website and three independent bearer-capability portals. They share an HTTP server, but they do not share authority, navigation, or frontend state.

## Four web authorities

| Surface              | How users obtain access                                                       | Authority                                                                                                                                                         | Lifetime / persistence                                                                                         |
| -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Harness Web Client   | Run `/login web` in a private chat once, then sign in with GitHub at `/login` | Create and drive only the GitHub principal's `platform=web` Conversation offices; read transcripts, prompt, cancel the exact run, and select model/thinking level | Cookie: 24 hours, memory-only. Completed admission binding: persisted in private State-dir `web-bindings.json` |
| Admin portal         | `/admin` or `/pi-admin`                                                       | Deployment and conversation administration, including settings, models, sandbox policy, events, and link generation                                               | 30-minute memory-only bearer token                                                                             |
| Login / vault portal | `/login` or `/pi-login`, or a link generated from Admin                       | Write API keys or OAuth credentials into one scoped vault                                                                                                         | 15-minute memory-only bearer token; consumed by a successful credential write                                  |
| Session View portal  | `session` or `/session`, or a link generated from Admin                       | View one scoped Harness session and its relations; when interactive wiring is available, submit a message to that same session                                    | 24-hour memory-only bearer token                                                                               |

## Harness Web Client

The website owns `/`, `/login`, and `/conversations/:officeKey`. It is a complete client of the daemon, not a shell around the portals.

### Admission and login

1. In a private platform conversation, `/login web` creates a five-minute proof code.
2. `/binding` completes GitHub OAuth and stores the immutable numeric principal as `github:<id>`. The GitHub login is display metadata and may change safely.
3. Completed admission bindings persist in `web-bindings.json`; pending proof codes remain in memory.
4. A later GitHub login succeeds only for an admitted principal and issues the `mikan_session` httpOnly, `SameSite=Lax` cookie. HTTPS responses also mark it `Secure`.

The admitting Slack, Discord, Telegram, or GitHub office is not website authorization and is never returned by Harness APIs. It only proves that the OAuth principal was invited through an existing private conversation.

### Web Conversation ownership

Each website conversation is a first-class `platform=web` Conversation office. Its raw id combines a random nonce with a keyed owner digest. The private `web-harness.key` and Office registry let the daemon enumerate only the current principal's offices without maintaining a second conversation inventory. OfficeKey's browser-visible readable segment contains only the random prefix—not the stable owner digest—and no host path is returned.

A browser mutation repeats the daemon-issued office key and full durable Session UUID. Cancel also repeats the current run id, so a stale tab cannot write to a replacement session or cancel a later run.

### Browser protocol

| Route                    | Method      | Authentication                                 | Purpose                                                                                                |
| ------------------------ | ----------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/api/me`                | `GET`       | `mikan_session`                                | Return the current OAuth principal and expiry                                                          |
| `/api/logout`            | `POST` JSON | `mikan_session` + JSON/same-origin CSRF checks | Revoke the browser session and clear the cookie                                                        |
| `/api/harness/bootstrap` | `GET`       | `mikan_session`                                | Return owned Conversation summaries, optional selected transcript, models, run state, and event cursor |
| `/api/harness/command`   | `POST` JSON | `mikan_session` + JSON/same-origin CSRF checks | Create a Conversation, prompt, cancel an exact run, or change model/thinking level                     |
| `/api/harness/events`    | `GET` SSE   | `mikan_session`                                | Resume principal-scoped ordered run and response events by epoch/sequence                              |

The browser folds contiguous events into temporary live state. A sequence gap, expired replay cursor, or daemon restart triggers a fresh bootstrap. Persisted SessionStore history replaces streamed text after the run settles.

`/api/offices` and the old cookie-to-Session-View-token bridge no longer exist. Unknown `/api/*` paths return a JSON `404` instead of the SPA document.

## Capability portals

Portal URLs are bearer capabilities. Their query-string tokens can leak through browser history, screenshots, copied URLs, or proxy logs; share them only with the intended recipient.

The portal prefixes `/session`, `/admin`, and `/link` are registered before static fallback and never render the Harness Web Client. A website cookie cannot be used as a portal token, and a portal token cannot authenticate Harness APIs.

| Route family                                      | Token source and check                        | Mutation behavior                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin`, `/admin/api/*`                          | `InMemoryAdminTokenStore.peek()`              | Token is reusable until expiry; Admin APIs may change settings and generate links                                                       |
| `/link`, `/api/link/*`, vault-mode `/oauth/*`     | `InMemoryLinkTokenStore.peek()` / `consume()` | JSON credential writes require CSRF checks; successful writes consume the token                                                         |
| `/session`, `/session/stream`, `/session/message` | `InMemorySessionViewTokenStore.peek()`        | View and SSE reuse the token; message submission is allowed only when runtime/bot wiring exists and stays scoped to the token's session |
| `/binding`, `/api/binding/info`                   | Five-minute pending binding code              | Completes only the OAuth admission ceremony; it grants no office capability                                                             |

## Why the authorities stay separate

- The browser cookie is reusable identity for principal-owned Web Conversations, not operator or secret-writing permission.
- Admin can change deployment behavior and therefore remains an explicit short-lived capability.
- Login/vault links can write secrets and are one-time on successful completion.
- Session View links are independently shareable and limited to one session, even when message submission is enabled.

Combining these tokens would let a copied session link become a credential or administration grant, or let a normal website login inherit ambient operator authority.

## Implementation locations

| Responsibility                        | Code                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| Harness host, ownership, runs, replay | `src/web/harness/`                                          |
| Daemon/browser wire contract          | `packages/harness-web-contract/`                            |
| React-free browser runtime and UI     | `packages/web-client/`, `apps/web/`                         |
| Route ordering and static fallback    | `src/web/server.ts`, `packages/web-host/`                   |
| OAuth admission and browser sessions  | `src/web/login/portal.ts`, `binding.ts`, `session-store.ts` |
| Admin capability portal               | `src/web/admin/`                                            |
| Login / vault capability portal       | `src/web/login/`                                            |
| Session View capability portal        | `src/web/session-view/`                                     |
| Shared short-lived token base         | `src/web/token-store.ts`                                    |

`startWebServer()` registers health/webhook routes, Harness APIs, capability portals, binding routes, an unknown-API guard, and finally the single Vite static fallback. The server starts when `LINK_PORT` / `MIKAN_LINK_PORT` is configured; a configured public link URL without an explicit port uses `8181`.
