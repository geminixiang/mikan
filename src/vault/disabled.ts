import type { VaultManager } from "./types.js";

/**
 * Inert VaultManager for embedders that run the conversation runtime without
 * a credential vault. Read paths report an empty, disabled vault; write paths
 * fail loudly so misconfiguration surfaces instead of silently dropping
 * secrets.
 */
export const disabledVaultManager: VaultManager = {
  isEnabled: () => false,
  hasEntry: () => false,
  resolve: () => undefined,
  list: () => [],
  listSharedVaults: () => [],
  deleteSharedVault: () => false,
  copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
  upsertEnv: () => {
    throw new Error("Vault not configured");
  },
  deleteEnvKey: () => {
    throw new Error("Vault not configured");
  },
  upsertFile: () => {
    throw new Error("Vault not configured");
  },
};
