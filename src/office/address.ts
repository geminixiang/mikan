import { createHash } from "node:crypto";
import { join } from "node:path";
import type { OfficeAddress, OfficeKey, PlatformName } from "../types.js";

const OFFICE_KEY_VERSION = "v1";
const OFFICE_KEY_DOMAIN = "office-address-v1";
const OFFICE_KEY_DIGEST_LENGTH = 16;
const READABLE_ID_LENGTH = 32;
const PLATFORM_NAMES = new Set<PlatformName>(["slack", "discord", "telegram", "github"]);

/** Construct the canonical identity used by future office consumers. */
export function createOfficeAddress(platform: PlatformName, conversationId: string): OfficeAddress {
  assertPlatformName(platform);
  assertConversationId(conversationId);
  return Object.freeze({ platform, conversationId });
}

/** Validate an untrusted runtime value as a canonical office address. */
export function validateOfficeAddress(value: unknown): OfficeAddress {
  if (!isRecord(value)) throw new Error("Office address must be an object");
  if (typeof value.platform !== "string") {
    throw new Error("Office address platform must be a string");
  }
  if (typeof value.conversationId !== "string") {
    throw new Error("Office address conversation id must be a string");
  }
  return createOfficeAddress(assertPlatformName(value.platform), value.conversationId);
}

/** Return true only for a supported platform name. */
function isPlatformName(value: unknown): value is PlatformName {
  return typeof value === "string" && PLATFORM_NAMES.has(value as PlatformName);
}

/** Validate a platform name and return it for typed callers. */
export function assertPlatformName(value: string): PlatformName {
  if (!isPlatformName(value)) throw new Error(`Unsupported platform: ${JSON.stringify(value)}`);
  return value;
}

/** Validate a raw platform conversation identifier before it enters storage. */
export function assertConversationId(value: string): string {
  if (value.length === 0 || value === "." || value === "..") {
    throw new Error("Conversation id must be non-empty and not a path marker");
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      character === "/" ||
      character === "\\" ||
      code === 0 ||
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      throw new Error("Conversation id must not contain path separators or control characters");
    }
  }
  return value;
}

/** Derive a readable diagnostic key whose digest remains the identity authority. */
export function officeKey(address: OfficeAddress): OfficeKey {
  const normalized = validateOfficeAddress(address);
  const readable = readableConversationId(normalized.conversationId);
  const digest = createHash("sha256")
    .update(`${OFFICE_KEY_DOMAIN}\0${normalized.platform}\0${normalized.conversationId}`)
    .digest("hex")
    .slice(0, OFFICE_KEY_DIGEST_LENGTH);
  return `${OFFICE_KEY_VERSION}-${normalized.platform}-${readable}-${digest}` as OfficeKey;
}

/**
 * Resolve the persistent workspace directory for an office.
 * Module-internal: registry/migration record target paths with it. Callers
 * outside `src/office/` use the `Office` value's `dir` field instead.
 */
export function officeDir(workspaceRoot: string, address: OfficeAddress): string {
  return join(workspaceRoot, officeKey(address));
}

/**
 * Resolve the host-only state directory for an office.
 *
 * Transitional: settings/packages/extension callers that only hold a
 * `stateDir` string keep using this until their option bags carry an
 * `Office` value (which exposes the same path as `stateDir`).
 */
export function officeStateDir(stateDir: string, address: OfficeAddress): string {
  return join(stateDir, "conversations", officeKey(address));
}

/** Compare canonical office identities without relying on their readable key. */
export function sameOffice(left: OfficeAddress, right: OfficeAddress): boolean {
  const leftAddress = validateOfficeAddress(left);
  const rightAddress = validateOfficeAddress(right);
  return (
    leftAddress.platform === rightAddress.platform &&
    leftAddress.conversationId === rightAddress.conversationId
  );
}

/** Validate a persisted or externally supplied office key. */
export function assertOfficeKey(value: string): OfficeKey {
  const pattern = /^v1-(slack|discord|telegram|github)-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{16}$/;
  if (!pattern.test(value)) throw new Error(`Invalid office key: ${JSON.stringify(value)}`);
  return value as OfficeKey;
}

export function isOfficeKey(value: unknown): value is OfficeKey {
  return typeof value === "string" && patternMatchesOfficeKey(value);
}

function readableConversationId(conversationId: string): string {
  const readable = conversationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, READABLE_ID_LENGTH)
    .replace(/-+$/g, "");
  return readable || "conversation";
}

function patternMatchesOfficeKey(value: string): boolean {
  return /^v1-(slack|discord|telegram|github)-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{16}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
