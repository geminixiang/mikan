import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "fs";
import { dirname, isAbsolute, join, normalize, sep } from "path";
import { officeKey } from "../office-address.js";
import { legacyConversationCredentialKey } from "../sandbox/identity.js";
import type { OfficeAddress } from "../types.js";
import { readTextFileIfExists } from "../utils/file-guards.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";

const PRIVATE_DIR_MODE = 0o700;
const SHARED_VAULT_DIR = "shared";
/**
 * Top-level vault namespaces that are not user vaults: `shared/<name>` holds
 * shared login profiles, `extensions/<slug>` holds extension secrets (read
 * host-side via the harness `api.secrets`, never mounted into sandboxes).
 */
const RESERVED_VAULT_DIRS = new Set([SHARED_VAULT_DIR, "extensions"]);

export function normalizeSharedVaultName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function sharedVaultKey(name: string): string | undefined {
  const normalized = normalizeSharedVaultName(name);
  return normalized ? `${SHARED_VAULT_DIR}/${normalized}` : undefined;
}

export type { ResolvedVault, VaultManager } from "./types.js";
import type { ResolvedVault, ResolvedVaultMount, VaultManager } from "./types.js";

// ── parseEnvFile ───────────────────────────────────────────────────────────────

/**
 * Parse a KEY=VALUE env file. Supports:
 * - Lines starting with # are comments
 * - Empty lines are skipped
 * - Values can be quoted with single or double quotes (quotes are stripped)
 * - No variable expansion
 * - The value is everything after the first `=` to end of line (no inline comments)
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIndex + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

// ── FileVaultManager ───────────────────────────────────────────────────────────

export class FileVaultManager implements VaultManager {
  private readonly vaultsDir: string;

  constructor(stateDir: string) {
    this.vaultsDir = join(stateDir, "vaults");
  }

  isEnabled(): boolean {
    return existsSync(this.vaultsDir);
  }

  hasEntry(key: string): boolean {
    if (!isSafeVaultKey(key)) return false;
    return existsSync(join(this.vaultsDir, key));
  }

  listSharedVaults(): string[] {
    const sharedDir = join(this.vaultsDir, SHARED_VAULT_DIR);
    if (!existsSync(sharedDir)) return [];
    return readdirSync(sharedDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && normalizeSharedVaultName(entry.name) === entry.name)
      .map((entry) => entry.name)
      .toSorted((left, right) => left.localeCompare(right));
  }

  deleteSharedVault(name: string): boolean {
    const key = sharedVaultKey(name);
    if (!key) throw new Error(`vault: invalid shared login name: ${name}`);
    const dir = join(this.vaultsDir, key);
    const existed = existsSync(dir);
    rmSync(dir, { recursive: true, force: true });
    return existed;
  }

  copySharedVaultTo(
    name: string,
    targetKey: string,
  ): { filesCopied: number; envKeysCopied: number } {
    if (!isSafeVaultKey(targetKey)) throw new Error(`vault: invalid vault key: ${targetKey}`);
    const sourceKey = sharedVaultKey(name);
    if (!sourceKey) throw new Error(`vault: invalid shared login name: ${name}`);
    const sourceDir = join(this.vaultsDir, sourceKey);
    if (!existsSync(sourceDir)) throw new Error(`vault: shared login "${name}" does not exist`);

    const targetDir = join(this.vaultsDir, targetKey);
    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(targetDir);
    return copyVaultDir(sourceDir, targetDir);
  }

  resolve(userId: string): ResolvedVault | undefined {
    if (!isSafeVaultKey(userId)) return undefined;
    const dir = join(this.vaultsDir, userId);
    if (!existsSync(dir)) return undefined;
    return this.buildResolved(userId);
  }

  list(): ResolvedVault[] {
    if (!existsSync(this.vaultsDir)) return [];
    const keys = new Set<string>();
    for (const entry of readdirSync(this.vaultsDir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !RESERVED_VAULT_DIRS.has(entry.name) &&
        isSafeVaultKey(entry.name)
      ) {
        keys.add(entry.name);
      }
    }
    return Array.from(keys, (key) => this.buildResolved(key));
  }

  upsertEnv(key: string, env: Record<string, string>): void {
    if (!isSafeVaultKey(key)) throw new Error(`vault: invalid vault key: ${key}`);
    const dir = join(this.vaultsDir, key);
    const envPath = join(dir, "env");
    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(dir);
    const existingContent = readTextFileIfExists(envPath);
    const existing = existingContent ? parseEnvFile(existingContent) : {};
    const merged = { ...existing, ...env };
    const content =
      Object.entries(merged)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([envKey, value]) => `${envKey}=${value}`)
        .join("\n") + "\n";
    atomicWritePrivateFile(envPath, content);
  }

  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void {
    if (!isSafeVaultKey(key)) throw new Error(`vault: invalid vault key: ${key}`);
    const normalizedPath = normalizeVaultRelativePath(relativePath);
    if (!normalizedPath || (targetPath !== undefined && !normalizeVaultTargetPath(targetPath))) {
      throw new Error(`vault: invalid relative secret file path for "${key}": ${relativePath}`);
    }

    const dir = join(this.vaultsDir, key);
    const filePath = join(dir, normalizedPath);

    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(dir);
    const parentDir = dirname(filePath);
    if (parentDir !== dir) ensurePrivateDir(parentDir);
    atomicWritePrivateFile(filePath, content);
  }

  // ── private ────────────────────────────────────────────────────────────────

  private buildResolved(key: string): ResolvedVault {
    const dir = join(this.vaultsDir, key);
    const mounts = inferMountsFromDir(dir);

    const envContent = readTextFileIfExists(join(dir, "env"));
    const env = envContent === undefined ? {} : parseEnvFile(envContent);

    return {
      userId: key,
      displayName: key,
      dir,
      mounts,
      env,
    };
  }
}

function inferMountsFromDir(dir: string): ResolvedVaultMount[] {
  if (!existsSync(dir)) return [];

  const mounts: ResolvedVaultMount[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "env") continue;
    const source = join(dir, entry.name);
    const target = inferredVaultTargetPath(entry.name);
    if (!target) continue;
    mounts.push({ source, target });
  }
  return mounts;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(path, PRIVATE_DIR_MODE);
}

function copyVaultDir(
  sourceDir: string,
  targetDir: string,
): {
  filesCopied: number;
  envKeysCopied: number;
} {
  let filesCopied = 0;
  let envKeysCopied = 0;

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.name === "env" && entry.isFile()) {
      const sourceEnv = parseEnvFile(readTextFileIfExists(sourcePath) ?? "");
      const targetEnv = parseEnvFile(readTextFileIfExists(targetPath) ?? "");
      const merged = { ...targetEnv, ...sourceEnv };
      const content =
        Object.entries(merged)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([envKey, value]) => `${envKey}=${value}`)
          .join("\n") + "\n";
      atomicWritePrivateFile(targetPath, content);
      envKeysCopied += Object.keys(sourceEnv).length;
      continue;
    }

    if (entry.isDirectory()) {
      ensurePrivateDir(targetPath);
      const nested = copyVaultDir(sourcePath, targetPath);
      filesCopied += nested.filesCopied;
      envKeysCopied += nested.envKeysCopied;
      continue;
    }

    if (!entry.isFile()) continue;
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, 0o600);
    filesCopied++;
  }

  return { filesCopied, envKeysCopied };
}

function isSafeVaultKey(key: unknown): key is string {
  if (typeof key !== "string" || !key || isAbsolute(key)) return false;
  if (/^[A-Za-z]:[\\/]/.test(key)) return false;

  return key.split(/[\\/]/).every((segment) => {
    return (
      segment !== "" && segment !== "." && segment !== ".." && !hasUnsafeControlCharacter(segment)
    );
  });
}

function hasUnsafeControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code >= 0 && code <= 31) || (code >= 127 && code <= 159);
  });
}

function normalizeVaultRelativePath(relativePath: string): string | undefined {
  const trimmed = relativePath.trim();
  if (!trimmed || isAbsolute(trimmed)) return undefined;

  const normalized = normalize(trimmed).split(sep).join("/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function normalizeVaultTargetPath(targetPath?: string): string | undefined {
  if (targetPath === undefined) return undefined;

  const trimmed = targetPath.trim();
  if (!trimmed || !trimmed.startsWith("/")) return undefined;

  const normalized = normalize(trimmed).split(sep).join("/");
  return normalized.startsWith("/") ? normalized : undefined;
}

export function defaultVaultTargetPath(relativePath: string): string {
  const normalized = normalizeVaultRelativePath(relativePath) ?? relativePath.replace(/^\/+/, "");
  return `/root/${normalized}`;
}

function inferredVaultTargetPath(relativePath: string): string | undefined {
  const normalized = normalizeVaultRelativePath(relativePath);
  if (!normalized) return undefined;

  if (normalized === "gws.json") {
    return "/root/.config/gws/credentials.json";
  }
  if (normalized === "gcloud-adc.json") {
    return "/root/.config/gcloud/application_default_credentials.json";
  }
  if (normalized === ".ssh" || normalized.startsWith(".ssh/")) {
    return "/root/.ssh";
  }
  if (normalized === ".kube" || normalized.startsWith(".kube/")) {
    return "/root/.kube";
  }
  if (normalized === ".config/gh" || normalized.startsWith(".config/gh/")) {
    return "/root/.config/gh";
  }

  return defaultVaultTargetPath(normalized);
}

/**
 * Rename legacy raw-id conversation vault directories to office keys, driven
 * by the office registry's inventory (the only raw-id ↔ office authority).
 * Shared, user-keyed, and unrecognized directories are never touched. A
 * conflict — both the legacy and the office-key directory exist — is reported
 * for manual merge, never clobbered; callers treat it as fatal for boot so a
 * conversation cannot silently run with half its credentials.
 */
export function migrateConversationVaultKeys(options: {
  stateDir: string;
  offices: readonly OfficeAddress[];
}): { migrated: string[]; conflicts: string[] } {
  const vaultsDir = join(options.stateDir, "vaults");
  const migrated: string[] = [];
  const conflicts: string[] = [];
  if (!existsSync(vaultsDir)) return { migrated, conflicts };

  for (const office of options.offices) {
    const legacyDir = join(vaultsDir, legacyConversationCredentialKey(office.conversationId));
    if (!existsSync(legacyDir)) continue;
    const targetDir = join(vaultsDir, officeKey(office));
    if (existsSync(targetDir)) {
      conflicts.push(office.conversationId);
      continue;
    }
    renameSync(legacyDir, targetDir);
    migrated.push(office.conversationId);
  }
  return { migrated, conflicts };
}
