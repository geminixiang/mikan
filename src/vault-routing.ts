import { DockerContainerManager } from "./provisioner.js";
import type { SandboxConfig } from "./sandbox/index.js";
export function resolveActorVaultKey(
  baseConfig: SandboxConfig,
  userId: string,
  conversationId: string,
): string {
  if (baseConfig.type === "container") {
    return containerSharedVaultId(baseConfig.container);
  }

  if (
    baseConfig.type === "image" ||
    baseConfig.type === "cloudflare" ||
    baseConfig.type === "firecracker"
  ) {
    return DockerContainerManager.sanitizeSegment(conversationId);
  }

  return userId;
}

export function containerSharedVaultId(containerName: string): string {
  return `container-${containerName}`;
}
