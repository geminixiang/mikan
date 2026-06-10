# src/vault

File-backed credential vault for env secrets, secret files, shared profiles, and sandbox mounts.

This layer is sandbox-agnostic: vault keys are scope keys derived by
`resolveActorScopeKey()` in `src/sandbox/registry.ts` from each provider's declared
credential scope.

## Files

- `index.ts`: Implements `FileVaultManager`, vault key normalisation, env-file parsing, and shared/private vault operations.
