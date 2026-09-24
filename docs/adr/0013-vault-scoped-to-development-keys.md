---
status: accepted
---

# Vault is scoped to development keys

The Vault holds only the keys that R&D development services need injected into a conversation's sandbox container. Every other external credential, shared or personal, goes through OpenConnector.

## Context

The Vault started as a broad mechanism: any credential, for any purpose, copied or mounted into sandboxes. It grew three identity tiers on top of that store:

- Shared machine identity through `sandbox.defaultSharedVault`, copied into every new conversation. It was retired in `cec86ddb`. A missing profile made every run fail, and the copy handed the same broad credentials to every conversation.
- Named shared profiles (`/login shared *`, `/login copy <name>`), which copy operator credentials into a conversation vault on request.
- Personal OAuth identity through `/pi-login`, stored in the conversation vault.

Anything placed in the Vault becomes readable inside the sandbox, so the agent and any tool it runs can read it. OpenConnector keeps provider OAuth on its side, gives each Conversation office a revocable runtime token (the Conversation integration identity), and is provisioned host-side, so the admin token never enters a sandbox.

## Considered Options

- **Scope the Vault to development keys (chosen)**: some development workflows need a raw key inside the container, such as a database URL, a package registry token, or a test API key. Only the Vault can do that. Everything else gains audit and revocation by moving to OpenConnector.
- **Keep the Vault as the general credential store**: keeps raw secrets for third-party services inside sandboxes and duplicates what OpenConnector already does.
- **Remove the Vault entirely**: leaves no way to give development tooling a key that must be present as an environment variable or file in the container.

## Consequences

- New integrations with external services use OpenConnector. A new use of the Vault needs a development workflow that requires the raw key inside the container.
- Conversation vault `env` injection stays. Vault file mounts stay only as long as a development workflow needs file-shaped keys.
- Named shared profiles and `/pi-login` personal OAuth are outside this scope. They are removed once OpenConnector covers their use cases. Until then they remain, and the product docs describe them as transitional.
- The admin portal's vault management shrinks with the Vault: it keeps editing conversation `env`.
- The boot-time migration of legacy vault directories stays until existing deployments have migrated.
