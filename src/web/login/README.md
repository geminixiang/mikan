# src/web/login

This directory handles the login portal, OAuth service registry, and short-lived link tokens.

## Files

- `portal.ts`: Provides `InMemoryLinkTokenStore` and handles login link completion, API keys, OAuth, CSRF, vault writes, and notifications.
- `oauth.ts`: Defines the built-in OAuth service registry and OAuth configuration helpers.
- `types.ts`: Defines login credential kinds, OAuth service metadata, the `LinkToken` record, and the notification callback type.
