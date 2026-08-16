# Open Connector gateway

An optional, host-side OAuth action gateway. When configured, agents get
read-only tools for Google Workspace (Gmail, Calendar, Sheets) and a personal
GitHub account that execute on the host through a self-hosted
[Open Connector](https://github.com/oomol-lab/open-connector) deployment —
the provider's OAuth tokens never enter the sandbox.

This complements, and does not replace, the vault: guest CLIs (`gws`,
`gcloud`, `gh`) keep working through vault credential projection, and the
platform GitHub App adapter (`github_*` tools) is untouched. Rationale and
platform comparison: [`docs/research/connector-platform-selection.md`](https://github.com/geminixiang/mikan/blob/main/docs/research/connector-platform-selection.md).

## Configuration

| Env var                   | Meaning                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `CONNECTOR_GATEWAY_URL`   | Base URL of the self-hosted Open Connector service            |
| `CONNECTOR_RUNTIME_TOKEN` | Runtime token; may execute only the reviewed action allowlist |
| `CONNECTOR_ADMIN_TOKEN`   | Admin token; OAuth onboarding and connection management       |

All three normally live in the daemon environment (`~/.mikan/mikan.env`).
Without the runtime token the feature is disabled; without the admin token
existing connections keep working but onboarding/disconnect fails. The
onboarding page is served by the web portal, so `LINK_PORT` must be set.

### Hardening the connector deployment

Mikan treats the connector as trusted infrastructure; deploy it accordingly:

- set `OOMOL_CONNECT_ENCRYPTION_KEY` — without it the connector stores
  credentials in **plaintext** SQLite;
- set `OOMOL_CONNECT_ADMIN_TOKEN` and create a scoped runtime token whose
  action grants mirror mikan's allowlist (see below); don't reuse the admin
  token as the runtime token;
- disable the raw proxy (`OOMOL_CONNECT_BLOCKED_PROXIES=*`) — mikan never
  calls it;
- bind the service to a private interface reachable only by the mikan host;
- register your own Google / GitHub OAuth apps in the connector, with the
  connector's `/oauth/callback` as the redirect URL;
- back up `connect.sqlite` together with the encryption key.

## What the agent gets

Two tools, available on every platform once configured:

- `connector_gws` — `gmail_search`, `gmail_read_thread`,
  `calendar_list_events`, `sheets_read_range`
- `connector_github` — `whoami`, `my_repositories` (the connected personal
  account; distinct from the GitHub App's `github_*` tools)

The allowlist is code (`CURATED_ACTIONS` in `src/connector/gateway.ts`):
read-only, one connector action per tool action, no write actions and no raw
proxy in this first iteration. Results are size-capped before they reach the
conversation.

## Connecting an account

1. Run `/login` in a private conversation and open the link.
2. Follow "Connected services" to the `/connector` page.
3. Connect a service; authorize in the provider tab; the page confirms and
   the conversation is notified.

Connections are scoped to the conversation's credential authorization key —
the same principal that scopes its vault. One conversation (or, in host
sandbox mode, one user) can never reach another's connections; the model
never supplies connection identifiers.

## Migrating from vault-projected credentials

Migration is re-authorization, not credential import:

1. Deploy and harden the connector, set the `CONNECTOR_*` env vars, restart.
2. Re-authorize each account through the `/connector` page.
3. Workflows covered by the curated tools now run host-side; the agent needs
   no guest credential for them.
4. Optionally remove the corresponding vault entries (`gws.json`, GitHub
   OAuth tokens) from conversations that no longer need guest CLIs — keep
   them wherever `gws`/`gh` must still run inside the sandbox. Nothing is
   removed automatically.

To disconnect, use the `/connector` page (removes both the mikan mapping and
the connector-side credential), or delete the connection in the connector
console plus the entry in `<stateDir>/connector/connections.json`.
