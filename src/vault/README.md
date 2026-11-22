# src/vault

Scope: the Vault holds only the development keys that R&D services need injected into a sandbox container. Other external credentials go through OpenConnector; shared profiles and `/pi-login` OAuth are transitional ([ADR 0013](../../docs/adr/0013-vault-scoped-to-development-keys.md)).

File-backed credential vault for env secrets, secret files, shared profiles, and sandbox mounts.

## Vault keys

One directory under `<stateDir>/vaults/` per key. A run authenticates as its
**office key**, which is platform-scoped, so two platforms sharing a raw
conversation id can never resolve each other's credentials.

`shared/<name>` is a reserved namespace for named shared login profiles.
`extensions/` also remains reserved as a legacy namespace: executable
extensions are no longer loaded, but old secret files are left untouched and
must never be mistaken for user vaults or mounted into a Sandbox.

Legacy raw-id conversation dirs are renamed to office keys by `mikan migrate`.
Vaults that a `host` or `container:<name>` daemon wrote are left in place and
are not resolved.

## Identity model (which credentials a conversation gets)

Rule: **an agent's effective credentials must not exceed what the people able
to drive that conversation should wield**, and escalation is always explicit —
never ambient. Three identity tiers, narrowest first:

1. **Platform bot identity** (e.g. the GitHub agent token): host-side tokens
   that never enter the sandbox. Platforms whose trigger surface is wide
   (`MessagingInfo.trustModel: "open-trigger"`) get only this.
2. **Shared machine identity** (`sandbox.defaultSharedVault`): broad
   convenience credentials copied into each new conversation's vault. Only
   appropriate for `trustModel: "membership"` (Slack/Discord/Telegram/GitHub) on
   isolated sandboxes (`oci`). Decided by
   `allowsAmbientDefaultSharedVault` — not by platform name strings.
3. **Personal identity** (`/pi-login` OAuth): the agent acts as a specific
   person; granted knowingly by that person, scoped to their vault.

An admin can still explicitly provision a vault for any conversation
(including open-trigger ones); only the _ambient default_ is trust-gated.
