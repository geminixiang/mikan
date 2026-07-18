export interface ResolvedVaultMount {
  source: string;
  target: string;
}

/** Resolved vault ready for use at runtime */
export interface ResolvedVault {
  userId: string;
  displayName: string;
  /** Absolute path to vault directory */
  dir: string;
  /** Absolute mount specs */
  mounts: ResolvedVaultMount[];
  /** Parsed from env file */
  env: Record<string, string>;
}

export interface VaultInjection {
  env?: Record<string, string>;
  mounts: ResolvedVaultMount[];
}

export interface VaultManager {
  /** Return true when a vault directory exists for this exact key. */
  hasEntry(key: string): boolean;
  /** Resolve vault for a user; returns undefined when no directory exists. */
  resolve(userId: string): ResolvedVault | undefined;
  /** Get sandbox config with credential injection for a user */
  /** List all vaults discovered under vaults/. */
  list(): ResolvedVault[];
  /** Check if the vaults directory exists. */
  isEnabled(): boolean;
  /** Merge environment variables into vaults/<key>/env and persist them to disk. */
  upsertEnv(key: string, env: Record<string, string>): void;
  /** Write a private file into vaults/<key>/ and ensure it is mounted into the sandbox. */
  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void;
  /** List named shared login profiles under vaults/shared/. */
  listSharedVaults(): string[];
  /** Delete a shared login profile's directory. Returns true when it existed. */
  deleteSharedVault(name: string): boolean;
  /** Copy a shared login profile's files into another vault directory. */
  copySharedVaultTo(
    name: string,
    targetKey: string,
  ): { filesCopied: number; envKeysCopied: number };
}
