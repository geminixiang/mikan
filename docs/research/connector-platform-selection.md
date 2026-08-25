# Connector platform selection for mikan

Status: research recommendation (2026-08-16).

## Decision

**Adopt Open Connector as a host-side OAuth/API action gateway for a bounded proof of concept. Do not replace mikan's vault with either product.**

For mikan's immediate goal—let agents use a person's GitHub and Google Workspace accounts without placing long-lived provider credentials in the guest—Open Connector is the better fit:

- its Apache-2.0 license is materially easier for a public, self-hostable mikan integration than Nango's Elastic License 2.0;
- its self-hosted action gateway is available in the open repository, while free Nango self-hosting is limited to Auth, Proxy, and their observability and excludes Functions, Webhooks, and MCP;
- its runtime is directly shaped for agents: typed actions, HTTP, TypeScript SDK, OpenAPI, and MCP, with provider tokens kept behind the gateway;
- its smallest deployment is one Node service plus persistent SQLite, rather than Nango plus production PostgreSQL and Redis/Valkey.

This recommendation is deliberately narrow. Open Connector is only weeks old, has no managed continuous sync/trigger engine, and requires careful hardening. Nango is the stronger choice if mikan later needs a mature managed integration platform with scheduled syncs, webhook routing, retry infrastructure, and enterprise operations—and is willing to use Nango Cloud or pay for enterprise self-hosting.

Neither product replaces mikan's authorization, secret-class, or guest-materialization responsibilities.

## The category mistake to avoid

"Vault" currently names several distinct responsibilities in mikan. An OAuth broker covers only part of them.

| Responsibility                                                                | mikan vault today                                      | OAuth/action gateway                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| OAuth redirect, code exchange, token refresh                                  | Built into the login portal                            | Yes; a natural replacement                       |
| Encrypted provider connection storage                                         | Local vault files                                      | Yes                                              |
| Execute provider APIs without revealing credentials to the guest              | Generally no; credentials are materialized for CLI use | Yes; this is the main benefit                    |
| Arbitrary environment secrets and API keys                                    | Yes                                                    | No general replacement                           |
| Credential files for `gh`, `gws`, `gcloud`, SSH, Kubernetes, and similar CLIs | Yes                                                    | No                                               |
| Office/user/container authorization namespace                                 | Yes                                                    | No; mikan must map its principal to a connection |
| Membership versus open-trigger trust policy                                   | Yes                                                    | No                                               |
| Shared-profile copy policy                                                    | Yes                                                    | No                                               |
| Host-only extension secrets                                                   | Yes                                                    | No                                               |
| Daemon/platform secrets                                                       | Outside guest injection by design                      | No                                               |
| Sandbox-specific env/file projection with fail-closed behavior                | Yes                                                    | No                                               |

The existing contract is explicit:

- a conversation's own vault is intended to reach its guest as environment variables and selected credential files;
- daemon credentials and extension secrets remain host-only;
- the whole vault directory is never mounted;
- sandbox modes that cannot project a required credential file fail instead of silently running without it.

See [`src/content/docs/sandbox/vault.md:71`](../../src/content/docs/sandbox/vault.md#what-reaches-the-sandbox) and the storage/projection interface in [`src/vault/types.ts:23`](../../src/vault/types.ts).

Therefore the useful target is not:

```text
Open Connector or Nango replaces VaultManager
```

It is:

```text
Mikan principal and policy authority
  ├── office/user/container identity
  ├── membership/open-trigger policy
  ├── platform and extension secret classes
  └── authorization: principal → provider connection
                         │
                         ▼
Host-side connector gateway
  ├── OAuth lifecycle and encrypted provider connection
  ├── scoped provider actions / optional proxy
  └── response returned to a mikan host tool
                         │
                         ▼
Guest sees tool schemas and results, not refresh tokens

Existing VaultManager remains for arbitrary env/file credentials
and for CLIs that must authenticate inside the guest.
```

## Comparative summary

| Dimension               | Nango                                                                                         | Open Connector                                                                                                    | Consequence for mikan                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| License                 | Elastic License 2.0; source-available, not OSI open source                                    | Apache-2.0; SDK is MIT                                                                                            | **Open Connector wins** for a community harness and distributable integration                          |
| Free self-host product  | Auth, Proxy, and Auth/Proxy observability; no Functions, Webhooks, or MCP                     | Gateway, actions, proxy, OpenAPI, MCP, and TypeScript SDK are in the open repository                              | **Open Connector wins** for the intended agent action plane                                            |
| Minimum infrastructure  | Server + PostgreSQL + Redis/Valkey; optional Elasticsearch/OpenSearch                         | Node 22 + persistent SQLite, or Workers + D1 + R2/KV                                                              | **Open Connector wins** for a small mikan deployment                                                   |
| OAuth lifecycle         | Mature connection model; refresh, validation, reconnect flow                                  | OAuth2/API key/custom credentials; refresh and reconnect                                                          | Both cover the immediate need                                                                          |
| Credential exposure     | Proxy/Functions can retain credentials, but privileged SDK can retrieve them                  | Runtime action API does not return raw provider credentials                                                       | Both can enforce the desired boundary only if mikan withholds privileged/admin capabilities            |
| Encryption              | Required self-host key; authenticated encryption and KMS paths; documented key rotation gap   | Optional key; without it secrets are stored in plaintext; Node includes rotate-key CLI                            | Nango has the safer default; Open Connector needs mandatory startup policy in mikan deployment         |
| GitHub                  | User OAuth, GitHub App, GitHub App OAuth; mature provider metadata and proxy support          | Large typed GitHub action surface                                                                                 | Keep mikan's existing GitHub App adapter; use either only for personal-account capabilities outside it |
| Google Workspace        | Broad auth/provider catalog across Gmail, Calendar, Sheets, Drive, Docs, admin APIs, and more | Deep typed actions for Gmail, Calendar, Drive, Docs, Sheets, and other Google services                            | **Open Connector fits agent tool use**; Nango fits generic proxy or managed integration workflows      |
| Actions                 | TypeScript Functions on Cloud/enterprise self-host                                            | First-party typed action catalog in free self-host                                                                | **Open Connector wins** for the proposed self-host PoC                                                 |
| Syncs/triggers/webhooks | Managed actions, scheduled syncs, record cache, retries, provider webhook routing             | Request/response actions; some incremental-read actions, but no documented persistent scheduler or trigger engine | **Nango wins decisively** if this becomes a sync platform                                              |
| Node/TypeScript fit     | Official `@nangohq/node`; Functions are TypeScript                                            | `@oomol-lab/connector` thin TypeScript client; HTTP/OpenAPI/MCP                                                   | Both are low-friction; Open Connector has the narrower seam                                            |
| Maturity                | Repository since 2020; active releases and substantial operating history                      | Repository created 2026-06-29; rapid activity but extremely short production history                              | **Nango wins**; Open Connector requires a reversible, bounded adoption                                 |

## Nango assessment

### Strengths

1. **Mature OAuth connection system.** An integration identifies a provider/auth scheme; a connection represents one authorized external account. Nango stores and refreshes credentials, validates them, reports `invalid_credentials`, and provides a reconnect flow.
2. **Broad provider coverage.** Its catalog includes GitHub user OAuth, GitHub App variants, and specific Google Workspace providers for Gmail, Calendar, Sheets, Drive, Docs, Workspace Admin, and others.
3. **Real integration runtime.** Beyond auth and proxying, the product supports TypeScript actions, incremental and bidirectional syncs, schedules, retry handling, record caching, and webhook routing.
4. **Good Node integration.** The official SDK covers Connect sessions, connections, credentials, proxy calls, actions, sync operations, integration management, and webhook verification.
5. **More operational history.** The repository dates to 2020 and remains actively released. This matters for OAuth edge cases, refresh behavior, provider drift, and operational recovery.

### Costs and constraints

1. **The license is ELv2, not an open-source license.** It permits many internal/self-host uses but restricts offering a substantial set of Nango features as a hosted or managed service. A mikan integration would need legal review before redistribution or commercial service use.
2. **The attractive runtime is not in free self-hosting.** Nango's own self-host matrix limits the free edition to Auth, Proxy, and their observability. Functions, Webhooks, and MCP require Nango Cloud or enterprise self-hosting. It would be misleading to evaluate the README's complete platform as the free deployable product.
3. **Heavier operations.** Production requires durable external PostgreSQL and Redis/Valkey. Elasticsearch/OpenSearch is optional for execution-log search. Operators must also protect the dashboard, expose OAuth callbacks, back up data and the encryption key, and preserve outbound/inbound network policy.
4. **Credential non-exportability is not absolute.** Proxy/Functions can keep provider tokens inside Nango, but a privileged backend SDK can retrieve connection credentials. Mikan must still ensure that neither the Nango API key nor credential-retrieval functions reach a guest or untrusted extension.
5. **Self-host key rotation is a known gap.** Official documentation and source indicate encryption-key rotation is not supported. Losing or changing the key makes stored credentials undecryptable.

### Best Nango use case for mikan

Choose Nango instead if the requirement becomes:

- durable scheduled ingestion from many SaaS providers;
- provider webhooks normalized into mikan events;
- incremental/bidirectional sync with a record cache;
- enterprise support and observability;
- willingness to use Nango Cloud or enterprise self-hosting.

For OAuth plus on-demand agent tools alone, it buys more platform and operational machinery than mikan currently needs.

## Open Connector assessment

### Strengths

1. **The product seam matches an agent harness.** A client discovers typed actions, selects a connection, executes an action, and receives structured output. Provider credentials remain in the gateway. HTTP, TypeScript, OpenAPI, CLI, and MCP surfaces are available.
2. **Permissive licensing.** Apache-2.0 permits modification, commercial use, and redistribution subject to its notice and attribution terms. This is compatible with mikan's goal of being a foundation other developers can build upon.
3. **Small self-host footprint.** The Node deployment uses one service and persistent `connect.sqlite`; the Cloudflare option uses Workers, D1, and R2 or KV. The Node topology is appropriate for an initial single-host mikan deployment.
4. **Large typed action catalog.** At the time of research, the live first-party catalog reported 1,367 providers and 14,020 actions. The source includes extensive GitHub actions and detailed Gmail, Calendar, Drive, Docs, and Sheets actions.
5. **Better default interaction shape for secrets.** Its runtime API returns account metadata and action results, not the raw provider token. This makes a host-side capability boundary easier to preserve than guest credential projection.
6. **Key rotation exists for the Node store.** The Node CLI includes a SQLite key-rotation path, though backup and recovery still remain operator responsibilities.

### Costs and constraints

1. **It is exceptionally young.** The repository was created on 2026-06-29. Stars, contributors, and rapid releases show attention, not production maturity. OAuth behavior, schema stability, migrations, and security properties need direct PoC validation.
2. **Encryption is optional and plaintext is allowed.** Without `OOMOL_CONNECT_ENCRYPTION_KEY`, credentials, OAuth configuration/state, and some persisted responses are stored in plaintext with only a startup warning. Mikan must treat a missing encryption key as fatal in production.
3. **Authorization has two independent surfaces.** Runtime tokens can restrict actions and proxies, but an action allowlist does not restrict the raw proxy. Proxy grants and deployment-level proxy policy must be configured separately; the raw proxy should be disabled unless a concrete use requires it.
4. **It is not a trigger/sync platform.** Actions such as Gmail history listing, Calendar incremental sync, or Drive change listing expose provider primitives. They do not constitute a documented scheduler, durable cursor engine, webhook delivery system, or continuous sync runtime.
5. **Self-host OAuth apps remain mikan's responsibility.** Operators must register provider apps, configure callback URLs/scopes, and protect client secrets. Hosted OOMOL provides managed OAuth apps; the self-host version does not remove that setup.
6. **SQLite constrains the production envelope.** It lowers PoC cost but leaves backup, availability, concurrent writer behavior, disaster recovery, and migration discipline to mikan operators. It should initially be considered single-host infrastructure, not a horizontally scaled service.
7. **MCP is not the recommended trust seam.** Supporting MCP is useful for compatibility, but mikan should call the typed HTTP/TypeScript API through its own host tool so office identity and policy remain authoritative.

## Product-by-product fit for the requested services

### GitHub

Mikan already has a more purpose-specific host-side GitHub App path:

- the App private key remains on the host;
- the adapter mints short-lived installation tokens;
- host-side git operations can request a one-repository, permission-subset token;
- tokens are used for one invocation and are not written to `.git/config`;
- GitHub conversations are open-trigger surfaces and do not ambiently inherit shared vault credentials.

Do not replace this with either generic connector. It encodes mikan's platform identity and repository trust model more precisely.

Use Open Connector only for a separate **personal GitHub connection** when an agent needs user-level functionality not represented by the GitHub App adapter. Give that connection its own capability label and action policy so platform identity and personal identity cannot be confused.

Nango would be preferable only if GitHub data needs to join a larger managed sync/webhook pipeline.

### Google Workspace

Google Workspace is the strongest first PoC because mikan currently materializes OAuth client data and refresh tokens into `gws.json` for guest CLI use. A host-side gateway can remove that long-lived credential from the guest for workflows expressible as actions.

Open Connector already exposes detailed actions for:

- Gmail search/read/send/reply/drafts/labels/history/settings;
- Calendar calendars/events/free-busy/ACL and incremental reads;
- Drive search/read/export/changes/comments/permissions/revisions;
- Docs and Sheets read/write/batch-update operations.

The PoC should choose three concrete workflows rather than test catalog size—for example:

1. search Gmail and return message metadata;
2. list the next five Calendar events;
3. read a selected Sheet range, with write actions initially denied.

Retain `gws.json` vault projection for users who explicitly need the `gws` CLI inside a guest or need an API surface missing from Open Connector. Moving action-backed workflows host-side can reduce guest credential exposure incrementally without breaking CLI compatibility.

## Recommended mikan architecture

### 1. Add a connector capability above the sandbox boundary

The connector client belongs in the host runtime, exposed through mikan-defined tools or an extension. Do not put the connector admin token, encryption key, OAuth client secret, or provider refresh token into a user vault.

A suitable call path is:

```text
agent tool call
  → mikan host validates office/user + requested capability
  → mikan resolves an opaque connection reference
  → host invokes an allowlisted Open Connector action
  → host shapes/limits the response
  → tool result returns to the conversation
```

### 2. Keep mikan authoritative for identity and authorization

Store a mapping equivalent to:

```text
(mikan principal, provider, purpose) → opaque connector connection ID
```

The principal must use mikan's existing office/user semantics rather than an arbitrary ID supplied by the model. The model may select among human-readable authorized aliases, but it must not supply another user's raw connection ID.

A connection must declare its identity class, for example:

- `platform:github-app` — existing adapter; not delegated to Open Connector;
- `user:google-workspace` — personal Workspace OAuth connection;
- `user:github` — personal GitHub OAuth connection;
- `service:<purpose>` — future explicitly provisioned service identity.

### 3. Expose actions, not an unrestricted proxy

Generate or curate mikan tools from a reviewed action subset. At minimum, apply both:

- runtime-token action grants; and
- proxy grants/deployment proxy policy.

Disable the raw provider proxy for the first PoC. If introduced later, make each permitted provider/path/method a separate reviewed capability. Never expose connector admin APIs or credential retrieval to a guest.

### 4. Preserve the existing secret classes

| Secret class                                                | Storage and execution after adoption                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Provider refresh/access tokens for action-backed accounts   | Connector gateway; host-side only                                             |
| Connector encryption key and admin/bootstrap credentials    | Daemon environment/secret manager; never guest, never user vault              |
| Provider OAuth client secrets                               | Host-side connector configuration                                             |
| Mikan platform tokens and GitHub App key                    | Existing daemon boundary                                                      |
| Extension secrets                                           | Existing `vaults/extensions/<slug>` host API                                  |
| User API keys/env and credential files needed by guest CLIs | Existing conversation/shared vault                                            |
| Short-lived connector runtime credential, if needed         | Host process only; preferably one narrowly scoped token per mikan integration |

### 5. Make the connector optional and reversible

Define a narrow internal interface around connection onboarding, status, action discovery, and execution. Do not leak Open Connector-specific IDs or schemas into sessions, vault paths, or core office identity. This allows mikan to:

- disable the experiment without migrating unrelated vault data;
- substitute Nango later for managed sync workloads;
- support both platforms for different jobs;
- continue operating when the connector is unavailable.

This seam should be designed only after the PoC confirms real action schemas and error behavior; do not generalize from catalog metadata alone.

## Proof-of-concept acceptance checklist

### Functional

- [ ] A user connects one Google Workspace account through a mikan-owned onboarding flow.
- [ ] Mikan maps the connection to the authenticated user/office without trusting a model-supplied connection ID.
- [ ] Read-only Gmail, Calendar, and Sheets workflows execute through host-side actions.
- [ ] A disconnected/revoked account produces a clear reconnect state rather than a generic tool failure.
- [ ] Access-token expiry refreshes automatically without exposing the new token to mikan's guest.
- [ ] Existing `gws.json` vault-based CLI login continues to work unchanged for non-migrated users.

### Security

- [ ] Production startup fails if `OOMOL_CONNECT_ENCRYPTION_KEY` is absent.
- [ ] Admin auth and runtime auth are enabled; no development defaults survive deployment.
- [ ] The connector binds only to the intended private interface or network.
- [ ] The raw proxy is disabled; if not, proxy grants and deployment allowlists are tested separately from action grants.
- [ ] The runtime token can execute only the reviewed read-only actions.
- [ ] A user cannot enumerate, select, or execute another user's connection by guessing an ID or alias.
- [ ] The guest cannot read the connector runtime/admin token, provider access token, refresh token, OAuth client secret, or encryption key.
- [ ] Action results receive size limits and redaction appropriate to mikan's tool-result path.
- [ ] SSRF/private-network defaults are tested; private-network access remains disabled.

### Operations

- [ ] SQLite backup and restore are exercised, including encrypted credential recovery with the backed-up key.
- [ ] Key rotation is exercised on a disposable connection.
- [ ] Upgrade and migration are tested across at least two released versions.
- [ ] Connector outage, timeout, retry, and partial failure behavior are defined.
- [ ] Rate-limit responses from Google are surfaced and bounded rather than blindly retried.
- [ ] Logs and persisted action responses are inspected for sensitive provider data.
- [ ] A removal procedure deletes both the mikan connection mapping and upstream connector credential.

### Product fit

- [ ] Three real Google Workspace tasks succeed without falling back to raw proxy calls.
- [ ] The selected actions cover the intended user workflows, not merely the provider names.
- [ ] The operational cost is acceptable compared with retaining portal OAuth plus guest credential projection.
- [ ] The team explicitly accepts Open Connector's young-project risk before production rollout.

## Adoption sequence

1. **Keep the current vault and GitHub App adapter unchanged.**
2. **Run an isolated, read-only Google Workspace PoC** with Open Connector on one single-host deployment.
3. **Implement principal-to-connection authorization in mikan**, not in prompts or opaque guest configuration.
4. **Expose a curated host tool set**, with the raw proxy disabled.
5. **Verify security and recovery**, especially encryption-required startup, cross-user isolation, backup/restore, key rotation, and revoked credentials.
6. **Move only proven workflows off guest credentials.** Keep vault-backed CLI login as an explicit compatibility path.
7. **Re-evaluate after production evidence.** If scheduled syncs, webhooks, or enterprise support become primary requirements, compare Nango Cloud/enterprise against building those functions around Open Connector.

## Final recommendation

For mikan's present requirement, the ranking is:

1. **Open Connector, as an optional host-side action gateway** — best architectural and licensing fit, lowest self-hosting threshold, but adopt only through a hardened, reversible PoC.
2. **Nango, when the problem is managed integration infrastructure** — stronger maturity and sync/webhook capabilities, but heavier, license-constrained, and incomplete in free self-host mode for the desired action runtime.
3. **Neither as a vault replacement** — retain mikan's vault for arbitrary guest credentials/files, authorization routing, shared policy, extension secrets, and credential materialization.

The most important design improvement is not changing where a refresh token is stored. It is changing the execution model from **"put the user's token in the guest and run a CLI"** to **"authorize a host-side action and return only its result"** where the workflow permits it. Open Connector is currently the more direct way to test that model.

## Primary sources

### Nango

- [Repository and README](https://github.com/NangoHQ/nango)
- [Elastic License 2.0](https://github.com/NangoHQ/nango/blob/master/LICENSE)
- [Self-hosting feature matrix and operations](https://github.com/NangoHQ/nango/blob/master/docs/guides/platform/self-hosting.mdx)
- [Official Docker Compose topology](https://github.com/NangoHQ/nango/blob/master/docker-compose.yaml)
- [Auth guide](https://nango.dev/docs/guides/auth/auth-guide)
- [Node SDK](https://nango.dev/docs/reference/sdks/node)
- [Proxy requests](https://nango.dev/docs/guides/platform/proxy-requests)
- [Functions guide](https://nango.dev/docs/guides/functions/functions-guide)
- [Action functions](https://nango.dev/docs/guides/functions/action-functions)
- [Sync functions](https://nango.dev/docs/guides/functions/syncs/sync-functions)
- [External webhooks](https://nango.dev/docs/getting-started/use-cases/webhooks-from-external-apis)
- [Provider catalog source](https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml)
- [GitHub provider](https://nango.dev/docs/api-integrations/github)
- [GitHub App provider](https://nango.dev/docs/api-integrations/github-app)
- [Google Calendar](https://nango.dev/docs/api-integrations/google-calendar)
- [Gmail](https://nango.dev/docs/api-integrations/google-mail)
- [Google Sheets](https://nango.dev/docs/api-integrations/google-sheet)
- [Google Drive](https://nango.dev/docs/api-integrations/google-drive)
- [Workspace Admin](https://nango.dev/docs/api-integrations/google-workspace-admin)
- [Encryption manager source](https://github.com/NangoHQ/nango/blob/master/packages/shared/lib/utils/encryption.manager.ts)
- [KMS registry source](https://github.com/NangoHQ/nango/blob/master/packages/kms/lib/registry.ts)
- [Releases](https://github.com/NangoHQ/nango/releases)

### Open Connector

- [Repository and README](https://github.com/oomol-lab/open-connector)
- [Apache-2.0 license](https://github.com/oomol-lab/open-connector/blob/main/LICENSE.txt)
- [Docker Compose topology](https://github.com/oomol-lab/open-connector/blob/main/docker-compose.yml)
- [Credential and OAuth model](https://github.com/oomol-lab/open-connector/blob/main/docs/credentials.md)
- [Configuration and policy](https://github.com/oomol-lab/open-connector/blob/main/docs/configuration.md)
- [Runtime API](https://github.com/oomol-lab/open-connector/blob/main/docs/runtime-api.md)
- [SDK and CLI](https://github.com/oomol-lab/open-connector/blob/main/docs/sdk-cli.md)
- [TypeScript SDK](https://github.com/oomol-lab/connector-sdk)
- [Cloudflare deployment](https://github.com/oomol-lab/open-connector/blob/main/docs/cloudflare.md)
- [Gmail OAuth SDK tutorial](https://github.com/oomol-lab/open-connector/blob/main/docs/gmail-oauth-sdk.md)
- [Security policy](https://github.com/oomol-lab/open-connector/blob/main/SECURITY.md)
- [Node secret codec](https://github.com/oomol-lab/open-connector/blob/main/src/server/secrets/secret-codec.ts)
- [Worker secret codec](https://github.com/oomol-lab/open-connector/blob/main/src/server/secrets/worker-secret-codec.ts)
- [Live catalog](https://connector.oomol.com/v1/catalog)
- [Provider source tree](https://github.com/oomol-lab/open-connector/tree/main/src/providers)
- [GitHub actions](https://github.com/oomol-lab/open-connector/blob/main/src/providers/github/actions.ts)
- [Gmail actions](https://github.com/oomol-lab/open-connector/blob/main/src/providers/gmail/actions.ts)
- [Google Calendar actions](https://github.com/oomol-lab/open-connector/blob/main/src/providers/googlecalendar/actions.ts)
- [Google Drive actions](https://github.com/oomol-lab/open-connector/blob/main/src/providers/googledrive/actions.ts)
- [Google Docs actions](https://github.com/oomol-lab/open-connector/blob/main/src/providers/googledocs/actions.ts)
- [Google Sheets actions](https://github.com/oomol-lab/open-connector/blob/main/src/providers/googlesheets/actions.ts)
- [Releases](https://github.com/oomol-lab/open-connector/releases)

### Mikan

- [`VaultManager` contract](../../src/vault/types.ts)
- [Vault storage and projection](../../src/vault/index.ts)
- [Vault security and sandbox behavior](../../src/content/docs/sandbox/vault.md)
- [OAuth credential shaping](../../src/web/login/oauth.ts)
- [Login portal OAuth persistence](../../src/web/login/portal.ts)
- [Execution resolution and vault policy](../../src/execution-resolver.ts)
- [GitHub adapter security model](../../src/adapters/github/README.md)
- [GitHub App token client](../../src/adapters/github/client.ts)
- [Extension secret declarations](../../src/harness/extensions/types.ts)
- [Extension secret loading](../../src/harness/extensions/loader.ts)

Repository/activity figures and live-catalog counts are point-in-time observations from 2026-08-16. They indicate activity and breadth, not independently verified production quality.
