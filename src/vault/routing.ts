import { actorKey } from "../sandbox/identity.js";
import type { SandboxConfig } from "../sandbox/index.js";

/** The vault key for an actor — the shared runtime identity (see sandbox/identity.ts). */
export function resolveActorVaultKey(
  baseConfig: SandboxConfig,
  userId: string,
  conversationId: string,
): string {
  return actorKey(baseConfig, { userId, conversationId });
}
