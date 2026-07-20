import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { platform as hostPlatform } from "node:os";
import type {
  ConversationStorageScope,
  ResolveConversationStorageOptions,
  ResolvedConversationStorage,
} from "./types.js";
import { conversationStorageScope } from "./conversation-storage-scope.js";

const CLAIM_FILE = ".mikan-conversation-storage-claim.json";
const CLAIM_VERSION = 1;

interface StorageClaim {
  version: typeof CLAIM_VERSION;
  platform: ConversationStorageScope["platform"];
  conversationId: string;
  storageKey: string;
}

/**
 * Resolve one conversation directory, atomically claiming an old unscoped
 * directory only when the running coordinator has exactly one platform.
 * Ambiguous or conflicting storage always fails closed; this module never
 * merges directories or guesses an owner.
 */
export async function resolveConversationStorage(
  options: ResolveConversationStorageOptions,
): Promise<ResolvedConversationStorage> {
  const scope = conversationStorageScope(options.platform, options.conversationId);
  const scopedDir = join(options.workspaceRoot, scope.storageKey);
  const legacyDir = join(options.workspaceRoot, scope.conversationId);
  mkdirSync(options.workspaceRoot, { recursive: true });

  const scopedExists = pathKind(scopedDir, "scoped conversation storage") === "directory";
  const legacyExists = pathKind(legacyDir, "legacy conversation storage") === "directory";
  if (scopedExists && legacyExists) {
    throw new Error(
      `Conversation storage conflict: both scoped and legacy directories exist for ${scope.platform}/${scope.conversationId}`,
    );
  }
  if (scopedExists) {
    assertClaim(scopedDir, scope);
    return { ...scope, conversationDir: scopedDir, migratedLegacy: false };
  }
  if (!legacyExists) {
    try {
      mkdirSync(scopedDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (pathKind(scopedDir, "scoped conversation storage") !== "directory") throw error;
    }
    writeClaim(scopedDir, scope);
    syncDirectory(options.workspaceRoot);
    return { ...scope, conversationDir: scopedDir, migratedLegacy: false };
  }

  const activePlatforms = new Set(options.activePlatforms);
  if (activePlatforms.size !== 1 || !activePlatforms.has(scope.platform)) {
    throw new Error(
      `Legacy conversation storage ownership is ambiguous for ${scope.conversationId}; ` +
        "run an explicit operator migration before enabling multiple platforms",
    );
  }

  writeClaim(legacyDir, scope);
  await options.fenceLegacyAuthority?.();
  try {
    renameSync(legacyDir, scopedDir);
    syncDirectory(options.workspaceRoot);
  } catch (error) {
    if (
      pathKind(scopedDir, "scoped conversation storage") === "directory" &&
      pathKind(legacyDir, "legacy conversation storage") === "missing"
    ) {
      assertClaim(scopedDir, scope);
      return { ...scope, conversationDir: scopedDir, migratedLegacy: false };
    }
    throw new Error(
      `Cannot migrate legacy conversation storage for ${scope.platform}/${scope.conversationId}`,
      { cause: error },
    );
  }
  return { ...scope, conversationDir: scopedDir, migratedLegacy: true };
}

export function readConversationStorageClaim(conversationDir: string): ConversationStorageScope {
  const name = conversationDir.split(/[\\/]/).at(-1) ?? "";
  if (pathKind(conversationDir, "scoped conversation storage") !== "directory") {
    throw new Error(`Conversation storage directory does not exist: ${conversationDir}`);
  }
  const path = join(conversationDir, CLAIM_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read conversation storage claim ${path}`, { cause: error });
  }
  if (!isStorageClaim(parsed)) {
    throw new Error(`Invalid conversation storage claim ${path}`);
  }
  const scope = conversationStorageScope(parsed.platform, parsed.conversationId);
  if (scope.storageKey !== parsed.storageKey || scope.storageKey !== name) {
    throw new Error(`Conversation storage claim does not match directory ${conversationDir}`);
  }
  return scope;
}

function isStorageClaim(value: unknown): value is StorageClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return (
    Object.keys(claim).length === 4 &&
    claim.version === CLAIM_VERSION &&
    typeof claim.platform === "string" &&
    (["slack", "discord", "telegram", "github"] as string[]).includes(claim.platform) &&
    typeof claim.conversationId === "string" &&
    typeof claim.storageKey === "string"
  );
}

function pathKind(path: string, label: string): "missing" | "directory" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new Error(`Cannot inspect ${label} ${path}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return "directory";
}

function writeClaim(dir: string, expected: ConversationStorageScope): void {
  const path = join(dir, CLAIM_FILE);
  const claim: StorageClaim = { version: CLAIM_VERSION, ...expected };
  const content = JSON.stringify(claim) + "\n";
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      assertClaim(dir, expected);
      return;
    }
    throw error;
  }
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`Cannot make progress writing ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(path);
    } catch {
      // Preserve the write error.
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  syncDirectory(dir);
}

function assertClaim(dir: string, expected: ConversationStorageScope): void {
  const path = join(dir, CLAIM_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read conversation storage claim ${path}`, { cause: error });
  }
  if (!isMatchingClaim(parsed, expected)) {
    throw new Error(
      `Conversation storage claim does not match ${expected.platform}/${expected.conversationId}`,
    );
  }
}

function isMatchingClaim(
  value: unknown,
  expected: ConversationStorageScope,
): value is StorageClaim {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return (
    Object.keys(claim).length === 4 &&
    claim.version === CLAIM_VERSION &&
    claim.platform === expected.platform &&
    claim.conversationId === expected.conversationId &&
    claim.storageKey === expected.storageKey
  );
}

function syncDirectory(path: string): void {
  if (hostPlatform() === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
