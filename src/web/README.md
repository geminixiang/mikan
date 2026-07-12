# src/web

Web portals served by the link server.

## Files

- `portal-shell.ts`: Shared HTML shell (nav, topbar, CSS) for admin / session / vault portals.
- `server.ts`: HTTP server that mounts portal routes.

## Subdirectories

- `admin/`: Admin portal and admin token storage.
- `login/`: Login/OAuth portal, login command parsing, and link token storage.
- `session-view/`: Session View command, portal, model loader, and token storage.
