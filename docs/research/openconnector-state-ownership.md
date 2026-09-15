# OpenConnector token state ownership

Research date: 2026-09-15. This is a recommendation, not an accepted migration or
implemented policy. No production files, credentials, or OpenConnector API state
were inspected or changed.

## Source baseline

- mikan committed source: `c6150471a9a93898de41128bc1310d53c30de111`.
  The uncommitted experiment replacing automatic provisioning with a supplied
  runtime token is paused and is **not** the research baseline.
- OpenConnector primary source:
  [`95b2babf91e20a8686c3362b7fb4e4c717cc0bc2`](https://github.com/geminixiang/open-connector/tree/95b2babf91e20a8686c3362b7fb4e4c717cc0bc2).
  Source fetched with GitHub's contents API, not a live deployment API. Production
  OpenConnector version and configuration were not verified.

## What startup configuration actually did

mikan commit `3b39a4826f8fcd0db0cf425b493028c3cdb091a1` moved the reserved
OpenConnector endpoint selection into startup configuration. It retained the
per-Office provisioning introduced by `97ecc660e998a31874f20f12ee5348f5de550b68`.
Thus centrally configured access and multiple derived runtime identities coexist
in the implementation. The history establishes implementation history, not user
approval of every decision.

At the mikan baseline:

1. `src/main.ts:95-98` reads the deployment endpoint and passes configuration into
   the runtime (`:467-476`). It does not pre-create everyone's token at startup.
2. `src/harness/runner.ts:218-234,831-838` gates open-trigger MCP access, then
   provisions at runner construction using the Office and Slack workspace ID.
3. `src/harness/open-connector.ts:125-173` requests deployment policy and creates a
   named runtime token with action/proxy policy copied from that response.
4. `:191-225` reads/writes `<office.stateDir>/open-connector-runtime-token.json`;
   a persisted token is reused, validating origin/name. Creation is single-flight
   within this process. There is no token refresh/revoke implementation here.
5. `:235-287` pins the endpoint, replaces the MCP Authorization header, and
   disables only OpenConnector if provisioning fails. The admin credential never
   becomes the normal MCP header in this code path.

This mixes host integration lifecycle with runner materialization and Office
storage. Changing the filesystem location alone does not change that ownership.

## What OpenConnector actually stores and authorizes

### A derived token is not a reconstructible cache

[`runtime-token-service.ts`](https://github.com/geminixiang/open-connector/blob/95b2babf91e20a8686c3362b7fb4e4c717cc0bc2/src/server/storage/runtime-token-service.ts)
creates a random `oct_` token and stores its hash. Creation returns the plaintext;
list returns summaries without plaintext/hash. Resolving compares the hash and
returns token ID and policy. Names are labels in this service, not an idempotency
key. The service exposes create/list/update/revoke, not plaintext recovery.

Consequently automatic provisioning needs durable caller-side credential storage.
Keeping tokens only in RAM would require reissuing on restart and managing old
remote records. Deleting a local file is neither remote revocation nor recovery.
A crash after remote creation but before local persistence can orphan a remote
record; moving paths does not fix the two-system transaction.

### Separate tokens have potential value beyond names

The same service stores `allowedConnections`, `allowedActions`, `blockedActions`,
and `allowedProxies`, plus ID/last-use metadata. Tests in
[`runtime-token-service.test.ts`](https://github.com/geminixiang/open-connector/blob/95b2babf91e20a8686c3362b7fb4e4c717cc0bc2/src/server/storage/runtime-token-service.test.ts)
cover connection-policy preservation and empty-list behavior.

[`action-policy.ts:176-195`](https://github.com/geminixiang/open-connector/blob/95b2babf91e20a8686c3362b7fb4e4c717cc0bc2/src/core/action-policy.ts#L176-L195)
allows all connections when `allowedConnections` is empty; otherwise it checks
exact connection IDs. mikan's current creation payload does not set this field.
That means current per-Office naming is not per-Office connection isolation, but
merging identities would discard the ability to revoke or scope them separately.
Connection scope is still not an ACL over all documents inside an account.

[`connect-server.ts:245-248,1002-1034`](https://github.com/geminixiang/open-connector/blob/95b2babf91e20a8686c3362b7fb4e4c717cc0bc2/src/server/connect-server.ts)
exposes list/create/update/delete token routes. Its request policy combines runtime
grant and deployment/runtime policy (`:1207-1224`).
[`auth.ts`](https://github.com/geminixiang/open-connector/blob/95b2babf91e20a8686c3362b7fb4e4c717cc0bc2/src/server/api/auth.ts)
resolves stored tokens at request authentication. Revocation can reject subsequent
requests; this does not promise cancellation of an already-running action.

### Correction to the paused experiment

OpenConnector also accepts a configured deployment runtime secret through
`LocalAuthOptions.runtimeToken`. This is compared as a configured secret rather
than looked up as an `oct_` record (`auth.ts:tokenForScope/hasValidToken`). Therefore
an `oct_` prefix is evidence for the **generated-token format**, not a universal
way to distinguish all valid runtime credentials from admin credentials. The
paused experiment's prefix-only startup validation was over-restrictive.

## Existing mikan storage conventions

| Location                                             | Existing ownership and consumers                                                       | Suitability                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `<workspace>/<OfficeKey>/`                           | Agent working data, projected into sandbox                                             | No host integration secrets                                                                      |
| `<stateDir>/conversations/<OfficeKey>/`              | Office-specific settings, channel classification, Dream checkpoint                     | Reasonable for genuinely Office-owned state; integration lifecycle is currently hidden here      |
| `<stateDir>/vaults/<OfficeKey>/` or `vaults/shared/` | Credential profiles intended for resolution/copy/injection into execution environments | Wrong consumer model for host-only MCP token state                                               |
| `<stateDir>/settings.json`                           | Declarative configuration, read/mutated by configuration/Admin paths                   | Avoid mixing generated bearer secrets with editable configuration                                |
| `<stateDir>/mikan.env` / process environment         | Operator-provided bootstrap secrets                                                    | Keep existing admin bootstrap input here; do not auto-rewrite generated tokens into operator env |
| Host integration-specific state subtree              | New proposed owner for generated integration records                                   | Best fit without changing user startup workflow                                                  |

Evidence: `src/office/types.ts:29-97`; `src/config.ts:258-302,378-391`;
`src/vault/index.ts:88-169,209-237,444-460`; `src/cli/onboard.ts`.
The existing Vault is not a generic host secret repository: shared profile copying
and sandbox env/mount injection are part of its semantics. Reusing it would need
an additional host-only class/exclusion policy just to prevent the wrong consumers.

`src/file-guards.ts:105-145` provides atomic sibling-temp rename writes with 0600.
This is useful but not a multi-process lock, directory symlink defense, or remote
transaction. A new owner still needs explicit 0700 directories, safe validated
reads, conflict handling, and content-free diagnostics.

## Recommended location and ownership

Keep the **existing startup inputs and automatic provisioning** unless a separate
workflow decision authorizes changing them. Centralize generated records under:

```text
<stateDir>/integrations/openconnector/
└─ tokens/
   └─ <OfficeKey>.json
```

This proposed directory does not exist as a new contract yet. `integrations` and
`openconnector` deliberately avoid hyphenated directory names. Preserve endpoint
origin, remote token ID/name, and Office/workspace binding in validated records.
Changing endpoint/account must not silently reuse or overwrite another identity;
the current single-endpoint deployment can reject mismatch rather than invent a
multi-provider configuration system. If multiple endpoints become a real need,
namespace records by integration identity at that time.

**Central storage does not mean one shared credential.** Per-Office records may
remain initially, retaining revocation granularity and avoiding an unrelated
identity merger. One file per token limits concurrent update contention compared
to a giant JSON map. SQLite is not needed solely to relocate these small records.

A host integration owner should handle provisioning/persistence and return only
the runner's resolved MCP configuration. The runner should not choose token paths,
read admin env independently, or manage remote credential records. Initializing
that owner at startup does not require eagerly minting tokens for every dormant
Office; lazy provisioning can remain an implementation detail with bounded
failures. Neither moving storage nor keeping token names creates actor-to-target
authorization; the wider Office policy still needs that work.

## Migration and verification before implementation

- First decide whether to adopt integration-owned storage while preserving current
  identity and startup behavior. Do not infer approval of a single shared token.
- Inventory source/target record metadata without printing token values. Old-file
  to new-file mapping must validate origin/name/Office; conflicts fail explicitly.
- Use an explicit, idempotent migration with private permissions and safe source
  checks. Verify target persistence before removing source. No permanent dual-path
  fallback. No remote revocation or token creation just to relocate existing state.
- Leave remote policy unchanged during relocation. New connection grants and
  revocation semantics require their own policy decision.
- Local loopback fake OpenConnector tests should verify first-create/restart reuse,
  multiple Offices, concurrent initialization, endpoint mismatch, failed remote
  creation, failure between remote success and local save, malformed/symlink state,
  0600/0700, migration retry/conflicts, and absence from sandbox Vault/projection.
- Existing OpenConnector source tests were read, not run. No installed-version or
  production permissions conclusions can be made from upstream HEAD alone.

## Current worktree

The previously paused provisioning-removal experiment remains uncommitted and
untouched during this research. It does not implement this recommendation and
must not be committed or deployed as though it had been approved. This research
adds only this document; no production or additional product-code changes were made.
