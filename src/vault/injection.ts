import { existsSync } from "fs";
import { reportUserFacingError } from "../observability/sentry.js";
import type { SandboxConfig } from "../sandbox/types.js";
import type { ResolvedVault, ResolvedVaultMount } from "./types.js";

/**
 * What an actor's vault contributes to one sandbox execution. This is the
 * vault side of credential injection — the execution resolver composes it
 * with its own workspace layout and per-actor config shaping, without
 * knowing what a vault mount means or when vault env may flow.
 */
export interface VaultInjection {
  /** Per-exec env; absent for host sandboxes (no isolation) and empty vaults. */
  env?: Record<string, string>;
  /** Credential mounts whose sources exist; missing sources are reported and skipped. */
  mounts: ResolvedVaultMount[];
}

export function resolveVaultInjection(options: {
  vault: ResolvedVault | undefined;
  sandboxType: SandboxConfig["type"];
  conversationId: string;
}): VaultInjection {
  const { vault, sandboxType, conversationId } = options;

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
    sandboxType !== "host" && vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
  return { ...(env ? { env } : {}), mounts };
}
