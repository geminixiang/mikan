# src/vault

Scope: the Vault holds only the development keys that R&D services need injected into a sandbox container. Other external credentials go through OpenConnector; shared profiles and `/pi-login` OAuth are transitional ([ADR 0013](../../docs/adr/0013-vault-scoped-to-development-keys.md)).

File-backed credential vault for env secrets, secret files, shared profiles, and sandbox mounts.

## Contracts

- `resolveVaultInjection` fails closed when a sandbox backend cannot mount vault files.
- `migrateConversationVaultKeys` reports a key collision for manual merge and never overwrites.
- `disabledVaultManager` serves embedders that construct the runtime without a vault: reads report empty or disabled, and writes throw.

## Vault keys

One directory under `<stateDir>/vaults/` per key. Which key a run
authenticates as is decided by `credentialAuthorizationKey`
(`sandbox/identity.ts`), never by this module:

| Sandbox type                              | Key                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| conversation-scoped (`image`, Cloudflare) | the **office key** — platform-scoped, so two platforms sharing a raw conversation id can never resolve each other's credentials |
| `host`                                    | a user-derived key (the host has no execution isolation to scope to)                                                            |
| `container`                               | a key derived from the deployment-chosen container name                                                                         |

`shared/<name>` is a reserved namespace for named shared login profiles.
`extensions/` also remains reserved as a legacy namespace: executable
extensions are no longer loaded, but old secret files are left untouched and
must never be mistaken for user vaults or mounted into a Sandbox.

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
