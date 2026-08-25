import { createHash } from "node:crypto";
import { officeKey } from "../office/index.js";
import type { OfficeAddress } from "../types.js";
import type { SandboxConfig } from "./types.js";

const IDENTITY_HASH_LENGTH = 12;

/** Identity a run authenticates as when resolving credentials. */
export interface CredentialScope {
  userId: string;
  /**
   * Office whose credentials the run may use — the vault-routing address
   * (`vaultConversationId` substituted where a command targets another
   * conversation's vault on the same platform).
   */
  address: OfficeAddress;
}

/**
 * Vault key for a run. Conversation-scoped sandboxes (image, gondolin,
 * firecracker, cloudflare) key credentials by office key: platform-scoped and
 * collision-resistant, so two platforms sharing a raw conversation id can
 * never resolve each other's credentials — and one identity string names the
 * office across the workspace, the registry, and the vault.
 *
 * Host mode keys by user (the host has no execution isolation to scope to)
 * and container mode by the deployment-chosen container; both are
 * platform-neutral on purpose and unchanged by ADR 0005.
 */
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

/**
 * The raw-id conversation vault key written before the office migration; the
 * boot-time vault migration renames these directories to office keys.
 */
export function legacyConversationCredentialKey(rawConversationId: string): string {
  return identityKey("conversation", rawConversationId);
}

/**
 * Sandbox resource identity (container name, gondolin instance, cloudflare
 * sandbox scope). Still raw-conversation-keyed: renaming it churns every
 * provisioned container on upgrade, so it migrates with the resource-naming
 * commit tracked by ADR 0005 — a cross-platform id collision here costs a
 * container recreate (mount signatures differ), never credential access.
 */
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
