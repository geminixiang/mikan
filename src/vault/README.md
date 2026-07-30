# src/vault

File-backed credential vault for env secrets, secret files, shared profiles, and sandbox mounts.

## Files

- `index.ts`: Implements `FileVaultManager`, vault key normalisation, env-file parsing, shared/private vault operations, and `migrateConversationVaultKeys` (legacy raw-id vault dirs → office-key dirs; a collision is reported for manual merge, never clobbered). Also owns what a run receives: `resolveVaultInjection` (env + file mounts, failing closed when a backend cannot mount vault files) and `allowsAmbientDefaultSharedVault` (trust model × sandbox topology).
- `disabled.ts`: A no-op `VaultManager` used when an embedder constructs the runtime without a vault; reads report empty/disabled, writes throw.
- `types.ts`: The `VaultManager` interface plus `ResolvedVault`, `ResolvedVaultMount`, and `VaultInjection`.

## Vault keys

One directory under `<stateDir>/vaults/` per key. Which key a run
authenticates as is decided by `credentialAuthorizationKey`
(`sandbox/identity.ts`), never by this module:

| Sandbox type                                                   | Key                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| conversation-scoped (image, gondolin, firecracker, cloudflare) | the **office key** — platform-scoped, so two platforms sharing a raw conversation id can never resolve each other's credentials |
| `host`                                                         | a user-derived key (the host has no execution isolation to scope to)                                                            |
| `container`                                                    | a key derived from the deployment-chosen container name                                                                         |

Two top-level names are reserved namespaces rather than vault keys:
`shared/<name>` for named shared login profiles, and `extensions/<slug>` for
extension secrets — read host-side through the harness `api.secrets` and
never mounted into a sandbox.

Only exact pre-hash host/shared-container keys remain readable as a legacy
fallback. Lossy managed-sandbox keys cannot prove ownership and are not
resolved; legacy raw-id conversation dirs are renamed to office keys by the
boot migration instead.

## Identity model (which credentials a conversation gets)

Rule: **an agent's effective credentials must not exceed what the people able
to drive that conversation should wield**, and escalation is always explicit —
never ambient. Three identity tiers, narrowest first:

1. **Platform bot identity** (e.g. the GitHub App): host-side, per-operation
   scoped tokens that never enter the sandbox. The default for platforms whose
   trigger surface is wide (`MessagingInfo.trustModel: "open-trigger"`).
2. **Shared machine identity** (`sandbox.defaultSharedVault`): broad
   convenience credentials copied into each new conversation's vault. Only
   appropriate for `trustModel: "membership"` (Slack/Discord/Telegram) on
   isolated sandboxes (`image` / `cloudflare`). Decided by
   `allowsAmbientDefaultSharedVault` — not by platform name strings.
3. **Personal identity** (`/pi-login` OAuth): the agent acts as a specific
   person; granted knowingly by that person, scoped to their vault.

An admin can still explicitly provision a vault for any conversation
(including open-trigger ones); only the _ambient default_ is trust-gated.
