# src/login

This directory handles login command parsing, OAuth/service registry, the login portal, and link tokens.

## Files

- `index.ts`: Defines login command parsing and the OAuth service registry, including built-in GitHub, Google Workspace CLI, and Google Cloud SDK services.
- `portal.ts`: Starts the login/secret portal HTTP server and handles API keys, OAuth, CSRF, vault writes, and notifications.
- `store.ts`: Provides a short-lived in-memory login link token store.
