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

### Running the connector under pm2

The pm2 deployment runs the connector **by default** as a sibling app of
mikan (declared in `deploy/pm2/ecosystem.config.cjs`): both autostart on
boot, but reloading/upgrading mikan never interrupts the connector's OAuth
flows, token refresh, or SQLite writes — and the connector (a young project)
can be upgraded on its own cadence. One-time setup:

```bash
git clone https://github.com/oomol-lab/open-connector ~/.mikan/open-connector
(cd ~/.mikan/open-connector && npm install)     # requires Node 22+
curl -o ~/.mikan/connector.env https://raw.githubusercontent.com/geminixiang/mikan/main/deploy/pm2/connector.env.example
chmod 600 ~/.mikan/connector.env                # fill in keys/tokens
pm2 start ecosystem.config.cjs && pm2 save
```

The connector's own settings live in `~/.mikan/connector.env`
(`OOMOL_CONNECT_*`); mikan's side stays in `~/.mikan/mikan.env`
(`CONNECTOR_GATEWAY_URL=http://127.0.0.1:3000` plus the same two tokens).
Upgrade independently of mikan:

```bash
(cd ~/.mikan/open-connector && git pull && npm install) && pm2 restart open-connector
```

The pm2 app pins `HOST=127.0.0.1`. One path must still be publicly reachable:
users' browsers land on `<OOMOL_CONNECT_ORIGIN>/oauth/callback` at the end of
each provider authorization, so expose exactly that path through your reverse
proxy / TLS termination and register it as the callback URL in your Google and
GitHub OAuth apps. The admin API, console, and `/v1` stay private.

### Hardening the connector deployment

Mikan treats the connector as trusted infrastructure; deploy it accordingly:

- set `OOMOL_CONNECT_ENCRYPTION_KEY` — without it the connector stores
  credentials in **plaintext** SQLite;
- set `OOMOL_CONNECT_ADMIN_TOKEN` and a separate runtime token; additionally
  pin the deployment-level action allowlist to mikan's curated set
  (`OOMOL_CONNECT_ALLOWED_ACTIONS`, pre-filled in `connector.env.example`) so
  even a leaked runtime token cannot execute anything else;
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
