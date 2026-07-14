import type { SandboxConfig } from "./types.js";

/**
 * Runtime actor identity: the one key that names a conversation's vault dir,
 * docker container and network, and cloudflare sandbox suffix. Everything
 * that needs such a name consumes actorKey(); nothing may re-derive or
 * re-sanitize it — two sanitizers with divergent outputs used to make a
 * container/vault mismatch a silent wrong-identity bug rather than an error.
 */
export function sanitizeIdentitySegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

/**
 * The actor key for a sandbox config: per-conversation for managed sandboxes
 * (image/gondolin/cloudflare/firecracker), the fixed container name for a shared
 * container, and the platform user id on the host.
 */
export function actorKey(
  baseConfig: SandboxConfig,
  ids: { userId: string; conversationId: string },
): string {
  if (baseConfig.type === "container") {
    return `container-${baseConfig.container}`;
  }
  if (
    baseConfig.type === "image" ||
    baseConfig.type === "gondolin" ||
    baseConfig.type === "cloudflare" ||
    baseConfig.type === "firecracker"
  ) {
    return sanitizeIdentitySegment(ids.conversationId);
  }
  return ids.userId;
}

/** Scope a base cloudflare sandbox id to one actor key. */
export function scopeCloudflareSandboxId(baseId: string, actorVaultKey: string): string {
  return `${baseId}-${sanitizeIdentitySegment(actorVaultKey)}`;
}
