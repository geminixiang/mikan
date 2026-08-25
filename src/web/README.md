# src/web

Web portals served by the link server.

## Files

- `portal-shell.ts`: Shared HTML shell (left rail, topbar, CSS) for admin / session / vault portals, plus the helpers every portal needs: `escapeHtml`, `requestBaseUrl`, and the size-limited `readRawBody`/`readJsonBody`.
- `server.ts`: HTTP server that mounts every portal route.
- `token-store.ts`: `InMemoryTokenStore`, the shared base for the three short-lived portal token stores (random token, TTL expiry).
- `types.ts`: `TokenRecord`, the token/expiry shape each store extends.

## Subdirectories

- `admin/`: Admin portal, model access-status resolution, and admin token storage.
- `login/`: Login/OAuth portal and link token storage.
- `session-view/`: Session View command, portal, session model loader, and token storage. A short-lived token authorizes read/navigation across the complete history of one canonical `OfficeAddress`; session UUIDs select the initial or viewed durable session but do not widen that office scope. Interactive continuation submits the viewed UUID, and the Sessions authority resolves its exact file and runtime key without changing the office's `current` pointer.
