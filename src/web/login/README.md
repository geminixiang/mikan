# src/web/login

Credential onboarding, OAuth admission binding, and short-lived browser sessions.

## Files

- `portal.ts`: Handles credential completion, OAuth/PKCE, stable OAuth-principal resolution, browser cookie issuance, CSRF, vault writes, and notifications.
- `binding.ts`: Keeps pending six-character proof codes in memory and persists completed OAuth admission bindings in private State-dir `web-bindings.json`.
- `binding-handler.ts`: Serves the standalone `/binding` ceremony and binding metadata API. `/login` belongs to the Harness Web Client.
- `session-store.ts`: Keeps 24-hour `mikan_session` cookies in process memory.
- `oauth.ts`: Defines the built-in OAuth service registry and OAuth configuration helpers.
- `types.ts`: Login credential, OAuth principal, binding, session, and notification types.
- `store.ts`: Short-lived credential-link capability tokens.

A completed chat binding permits the OAuth principal to sign into the website; it does not grant access to the bound platform Conversation office. Web Conversation ownership is independently enforced by `src/web/harness/`.
