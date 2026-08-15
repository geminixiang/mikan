# src/web

Host-side web surfaces and the React SPA integration.

`server.ts` composes named daemon routes ahead of the static SPA fallback. The built app in `apps/web/dist` owns page routes such as `/session`, `/admin`, `/link`, and `/login`; daemon handlers continue to own JSON, SSE, message, OAuth, and webhook routes.

## Web dashboard session

GitHub login is an identity flow, not an ambient admin capability:

1. A user runs `/login web` in a private platform conversation and completes `/binding`.
2. `/login` starts GitHub OAuth in `mode: "login"`.
3. The callback issues a 24-hour `mikan_session` httpOnly cookie only when the OAuth identity has an existing chat binding.
4. `/api/offices` accepts that cookie, filters the office registry to the exact bound conversation, omits host paths, and returns a scoped session-view URL when a session exists.
5. The React session page continues through the existing session-view token interface.

The web session and completed bindings are in memory. Restarting mikan requires binding and login again. A web session does not authorize Admin operations or vault writes; `/admin` and `/link` retain their dedicated capability tokens.

## Files

- `server.ts`: HTTP route composition, authenticated office discovery, and SPA fallback registration.
- `portal-shell.ts`: Legacy server-rendered shell plus shared request/body helpers.
- `token-store.ts`: Shared base for short-lived capability stores.
- `types.ts`: Shared web token record.
- `admin/`: Admin capability portal, APIs, and token storage.
- `login/`: Vault capabilities, OAuth/binding flows, and browser-session storage.
- `session-view/`: Session capability portal, JSON/SSE/message handlers, model loading, and token storage.
