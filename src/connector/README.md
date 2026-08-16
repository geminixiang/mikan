# src/connector

Host-side gateway to a self-hosted [Open Connector](https://github.com/oomol-lab/open-connector)
deployment: agents get curated, read-only provider tools (Gmail, Calendar,
Sheets, personal GitHub) whose OAuth tokens never enter the sandbox. This is
the execution-model change argued in
[`docs/research/connector-platform-selection.md`](../../docs/research/connector-platform-selection.md):
from "put the user's token in the guest and run a CLI" to "authorize a
host-side action and return only its result". The vault path (`gws.json`
projection, guest CLIs) is unchanged and remains the compatibility route.

## Files

- `client.ts`: `OpenConnectorClient` — minimal HTTP client. Runtime token for
  `/v1` action execution, admin token for `/api` onboarding/management;
  bounded responses; `ConnectorError` carries the connector's error code.
- `store.ts`: `ConnectorConnectionStore` — host-only mapping
  `(principal, service) → connectionName` at `<stateDir>/connector/connections.json`.
  Never a vault file: vault entries are materialized into guests, this must not be.
- `gateway.ts`: `ConnectorGateway` — the module's seam. Owns the reviewed
  read-only action allowlist (`CURATED_ACTIONS`), deterministic connection
  naming (`mikan-<service>-<hash>`; principal keys are hashed, not advertised),
  onboarding (start / poll-complete / disconnect), and execution with result
  size caps. Nothing outside the allowlist is executable; the raw connector
  proxy is never called.
- `tool-pack.ts`: `createConnectorToolPack` — `connector_gws` and
  `connector_github` as a platform tool pack (factory-injected from `main.ts`,
  bound per run). Bound on every platform; execution resolves the run's
  principal and fails with a reconnect hint when no connection exists.

## Identity and authorization

The principal is the run's credential authorization key
(`credentialAuthorizationKey` — the same key that scopes the vault), resolved
host-side from the bound run context. The model never sees or supplies a
connection name; a conversation can only ever reach connections onboarded for
its own principal. Onboarding rides the existing `/login` link-token flow
(private-conversation gated) via the `/connector` portal page.

## Secret classes (unchanged contract)

Connector runtime/admin tokens live in daemon env (`CONNECTOR_*`), never in a
vault and never in a guest. Provider refresh/access tokens live inside the
connector deployment. The guest sees tool results only.

## Deployment expectations

Self-hosted Open Connector with `OOMOL_CONNECT_ENCRYPTION_KEY` set, admin +
runtime auth enabled, the raw proxy disabled, and the runtime token's action
grants mirroring `CURATED_ACTIONS`. See `src/content/docs/connector.md`.
