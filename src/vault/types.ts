export interface ResolvedVaultMount {
  source: string;
  target: string;
}

export interface ResolvedVault {
  userId: string;
  displayName: string;
  dir: string;
  mounts: ResolvedVaultMount[];
  env: Record<string, string>;
}

export interface VaultInjection {
  env?: Record<string, string>;
  mounts: ResolvedVaultMount[];
}

export interface VaultManager {
  hasEntry(key: string): boolean;
  resolve(userId: string): ResolvedVault | undefined;
  list(): ResolvedVault[];
  isEnabled(): boolean;
  upsertEnv(key: string, env: Record<string, string>): void;
  deleteEnvKey(key: string, envKey: string): boolean;
  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void;
  listSharedVaults(): string[];
  deleteSharedVault(name: string): boolean;
  copySharedVaultTo(
    name: string,
    targetKey: string,
  ): { filesCopied: number; envKeysCopied: number };
}
