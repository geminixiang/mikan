import { existsSync } from "fs";
import { reportUserFacingError } from "../observability/sentry.js";
import type { SandboxConfig, SandboxCredentialCapabilities } from "../sandbox/types.js";
import type { ResolvedVault, ResolvedVaultMount, VaultInjection } from "./types.js";

export type { VaultInjection } from "./types.js";

export function resolveVaultInjection(options: {
  vault: ResolvedVault | undefined;
  capabilities: SandboxCredentialCapabilities;
  sandboxType: SandboxConfig["type"];
  conversationId: string;
}): VaultInjection {
  const { vault, capabilities, sandboxType, conversationId } = options;
  if (vault && vault.mounts.length > 0 && !capabilities.fileMounts) {
    throw new Error(`Sandbox type "${sandboxType}" does not support vault file mounts`);
  }

  const mounts: ResolvedVaultMount[] = [];
  for (const mount of vault?.mounts ?? []) {
    if (!existsSync(mount.source)) {
      reportUserFacingError(new Error("Vault mount source is missing"), {
        domain: "sandbox",
        surface: "vault_injection",
        operation: "resolve_mounts",
        severity: "warning",
        context: {
          sandboxType,
          conversationId,
          target: mount.target,
          hasVault: Boolean(vault),
        },
      });
      continue;
    }
    mounts.push({ source: mount.source, target: mount.target });
  }

  const env =
    capabilities.env && vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
  return { ...(env ? { env } : {}), mounts };
}
