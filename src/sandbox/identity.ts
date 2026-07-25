import { createHash } from "node:crypto";
import type { SandboxConfig } from "./types.js";

const IDENTITY_HASH_LENGTH = 12;

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

function identityKey(kind: "user" | "conversation" | "container", value: string): string {
  const readable = sanitizeIdentitySegment(value).slice(0, 40).replace(/-+$/g, "") || "unknown";
  const hash = createHash("sha256")
    .update(`${kind}\0${value}`)
    .digest("hex")
    .slice(0, IDENTITY_HASH_LENGTH);
  return `${readable}-${hash}`;
}
