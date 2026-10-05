import { createHash } from "node:crypto";
import { officeKey } from "../office/index.js";
import type { OfficeAddress } from "../types.js";
import type { CredentialScope, SandboxConfig } from "./types.js";

const IDENTITY_HASH_LENGTH = 12;

export function credentialAuthorizationKey(
  baseConfig: SandboxConfig,
  scope: CredentialScope,
): string {
  if (baseConfig.type === "host") return userCredentialKey(scope.userId);
  if (baseConfig.type === "container") return containerCredentialKey(baseConfig.container);
  return officeKey(scope.address);
}

export function userCredentialKey(userId: string): string {
  return identityKey("user", userId);
}

export function containerCredentialKey(container: string): string {
  return identityKey("container", container);
}

export function runtimeResourceKey(
  baseConfig: SandboxConfig,
  ids: { userId: string; address: OfficeAddress },
): string {
  if (baseConfig.type === "container") return identityKey("container", baseConfig.container);
  if (baseConfig.type === "host") return identityKey("user", ids.userId);
  return officeKey(ids.address);
}

export function sanitizeIdentitySegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function identityKey(kind: "user" | "container", value: string): string {
  const readable = sanitizeIdentitySegment(value).slice(0, 40).replace(/-+$/g, "") || "unknown";
  const hash = createHash("sha256")
    .update(`${kind}\0${value}`)
    .digest("hex")
    .slice(0, IDENTITY_HASH_LENGTH);
  return `${readable}-${hash}`;
}
