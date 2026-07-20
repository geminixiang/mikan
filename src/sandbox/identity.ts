import { createHash } from "node:crypto";
import type { SandboxConfig } from "./types.js";
import { SandboxError } from "./errors.js";

const IDENTITY_HASH_LENGTH = 12;

export function assertGondolinRemotePlatformIsolation(
  baseConfig: SandboxConfig,
  activePlatforms: string[],
  conversationStorageNamespaced = false,
): void {
  if (baseConfig.type !== "gondolin" || baseConfig.profile !== "remote") return;
  const active = new Set(activePlatforms.map((platform) => platform.trim()).filter(Boolean));
  if (!active.has("discord") || !active.has("telegram") || conversationStorageNamespaced) return;
  throw new SandboxError(
    "Error: gondolin:remote cannot run Discord and Telegram together because their numeric conversation IDs and workspace directories are not yet platform-namespaced",
    [
      "Run separate coordinators with separate state/workspace roots for Discord and Telegram, or use image:* until the conversation-storage migration is complete.",
    ],
  );
}

export function credentialAuthorizationKey(
  baseConfig: SandboxConfig,
  ids: { userId: string; conversationId: string },
): string {
  if (baseConfig.type === "host") return identityKey("user", ids.userId);
  if (baseConfig.type === "container") return identityKey("container", baseConfig.container);
  return identityKey("conversation", ids.conversationId);
}

export function legacyExactCredentialAuthorizationKey(
  baseConfig: SandboxConfig,
  ids: { userId: string; conversationId: string },
): string | undefined {
  if (baseConfig.type === "host") return ids.userId;
  if (baseConfig.type === "container") return `container-${baseConfig.container}`;
  return undefined;
}

export function runtimeResourceKey(
  baseConfig: SandboxConfig,
  ids: { userId: string; conversationId: string },
): string {
  if (baseConfig.type === "container") return identityKey("container", baseConfig.container);
  if (baseConfig.type === "host") return identityKey("user", ids.userId);
  return identityKey("conversation", ids.conversationId);
}

export function sanitizeIdentitySegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

export function scopeCloudflareSandboxId(baseId: string, resourceKey: string): string {
  return `${baseId}-${resourceKey}`;
}

function identityKey(kind: "user" | "conversation" | "container", value: string): string {
  const readable = sanitizeIdentitySegment(value).slice(0, 40).replace(/-+$/g, "") || "unknown";
  const hash = createHash("sha256")
    .update(`${kind}\0${value}`)
    .digest("hex")
    .slice(0, IDENTITY_HASH_LENGTH);
  return `${readable}-${hash}`;
}
