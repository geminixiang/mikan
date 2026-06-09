# src/vault

File-backed credential vault for env secrets, secret files, shared profiles, and sandbox mounts.

## Files

- `index.ts`: Implements `FileVaultManager`, vault key normalisation, env-file parsing, and shared/private vault operations.
- `routing.ts`: Resolves vault keys from sandbox type, user, conversation, or container name.
