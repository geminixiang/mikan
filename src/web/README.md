# src/web

Web portals served by the link server.

## Files

- `portal-shell.ts`: Shared HTML shell (left rail, topbar, CSS) for admin / session / vault portals.
- `request.ts`: `requestBaseUrl` — the configured link base URL, or one derived from the request's forwarded proto/host.
- `server.ts`: HTTP server that mounts every portal route.
- `token-store.ts`: `InMemoryTokenStore`, the shared base for the three short-lived portal token stores (random token, TTL expiry).
- `types.ts`: `TokenRecord`, the token/expiry shape each store extends.

## Subdirectories

- `admin/`: Admin portal, model access-status resolution, and admin token storage.
- `agent-events/`: The `/api/agent-events/stream` SSE route; the broadcast itself lives in `src/agent-events.ts`.
- `login/`: Login/OAuth portal and link token storage.
- `session-view/`: Session View command, portal, session model loader, and token storage.
