import { createHash } from "node:crypto";
import { officeKey } from "../office/index.js";
import type { OfficeAddress } from "../types.js";
import type { CredentialScope, SandboxConfig } from "./types.js";

export type { CredentialScope } from "./types.js";

const IDENTITY_HASH_LENGTH = 12;

export function credentialAuthorizationKey(
  baseConfig: SandboxConfig,
  scope: CredentialScope,
): string {
  if (baseConfig.type === "host") return identityKey("user", scope.userId);
  if (baseConfig.type === "container") return identityKey("container", baseConfig.container);
  return officeKey(scope.address);
}

export function legacyExactCredentialAuthorizationKey(
  baseConfig: SandboxConfig,
  scope: CredentialScope,
): string | undefined {
  if (baseConfig.type === "host") return scope.userId;
  if (baseConfig.type === "container") return `container-${baseConfig.container}`;
  return undefined;
}

export function legacyConversationCredentialKey(rawConversationId: string): string {
  return identityKey("conversation", rawConversationId);
}

export function runtimeResourceKey(
  baseConfig: SandboxConfig,
  ids: { userId: string; address: OfficeAddress },
): string {
  if (baseConfig.type === "container") return identityKey("container", baseConfig.container);
  if (baseConfig.type === "host") return identityKey("user", ids.userId);
  return officeKey(ids.address);
}

export function legacyConversationResourceKey(rawConversationId: string): string {
  return identityKey("conversation", rawConversationId);
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
