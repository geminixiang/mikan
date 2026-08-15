# src/web

Host-side Web Harness transport, authentication, and independent capability portals.

`server.ts` composes daemon-owned routes before one generic Vite static fallback. The Harness Web Client owns `/`, `/login`, and `/conversations/*`. `/session`, `/admin`, and `/link` are always handled by their server-rendered portal modules and can never fall through to the website shell.

## Web Harness authentication

GitHub login is an admission and identity flow, not ambient operator authority:

1. A user runs `/login web` in a private platform conversation and completes `/binding`.
2. The binding callback records the immutable OAuth subject (`github:<numeric-id>`) and display name in the private State-dir `web-bindings.json` ledger.
3. `/login` starts GitHub OAuth in `mode: "login"`.
4. The callback issues a 24-hour `mikan_session` httpOnly cookie only when that principal has a completed admission binding.
5. Harness API routes resolve the cookie to a principal; `src/web/harness/` independently authorizes that principal's Web Conversation offices.

Pending binding codes and browser sessions remain in memory. Completed admission bindings persist across restarts. A browser session grants no Admin, vault, or Session View capability.

## Harness application

`harness/` owns the daemon-side full client application: Web Conversation creation, durable transcript projection, prompt/cancel/model commands, and ordered resumable events. It reuses the process-wide `ConversationRuntime`; see [`harness/README.md`](harness/README.md).

The browser contract has three transport endpoints:

- `GET /api/harness/bootstrap`
- `POST /api/harness/command`
- `GET /api/harness/events`

Unknown `/api/*` paths return JSON 404 rather than the SPA document.

## Capability portals

The legacy portals serve links sent to Slack, Telegram, Discord, or GitHub users:

- `/session`: a scoped Session View capability, with its own JSON/SSE/message lifecycle.
- `/admin`: an operator capability for settings and deployment administration.
- `/link`: a short-lived credential onboarding capability.

Their bearer tokens remain mutually independent and are never read by the Harness Web Client. Their route prefixes are reserved even when the Vite dist is active.

## Files

- `server.ts`: route composition, portal precedence, Harness transport registration, SPA fallback.
- `harness/`: full Harness Web Host application.
- `portal-shell.ts`: capability-portal shell plus shared HTTP/CSRF helpers.
- `token-store.ts`: shared base for short-lived capability stores.
- `admin/`: Admin capability portal, APIs, and token storage.
- `login/`: credential portal, OAuth admission binding, and browser-session storage.
- `session-view/`: Session View capability portal, service, and token storage.
