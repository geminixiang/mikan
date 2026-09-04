# src/web

Web portals served by the link server.

## Files

- `portal-shell.ts`: Shared HTML shell (left rail, topbar, CSS) for admin / session / vault portals, plus the helpers every portal needs: `escapeHtml`, `requestBaseUrl`, and the size-limited `readRawBody`/`readJsonBody`.
- `server.ts`: HTTP server that mounts every portal route and returns its owning `Server` handle; the composition root retains and closes that handle before draining Conversation runtime work.
- `token-store.ts`: `InMemoryTokenStore`, the shared base for the three short-lived portal token stores (random token, TTL expiry).
- `types.ts`: `TokenRecord`, the token/expiry shape each store extends.

## Subdirectories

- `admin/`: Admin portal, model access-status resolution, and admin token storage.
- `login/`: Login/OAuth portal and link token storage.
- `session-view/`: Session View command, portal, session model loader, and token storage.
