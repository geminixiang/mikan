# src/vault

File-backed credential vault for env secrets, secret files, shared profiles, and sandbox mounts.

## Files

- `index.ts`: Implements `FileVaultManager`, vault key normalisation, env-file parsing, and shared/private vault operations.
- `routing.ts`: Resolves vault keys from sandbox type, user, conversation, or container name.
- `policy.ts`: Pure policy for ambient `defaultSharedVault` (trust model × sandbox topology).

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
