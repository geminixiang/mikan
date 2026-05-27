import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { dirname, isAbsolute, join, normalize, sep } from "path";
import { readTextFileIfExists } from "./file-guards.js";
import type { SandboxConfig } from "./sandbox/index.js";
import { atomicWritePrivateFile } from "./fs-atomic.js";
import { reportUserFacingError } from "./sentry.js";

const PRIVATE_DIR_MODE = 0o700;
const SHARED_VAULT_DIR = "shared";

export function normalizeSharedVaultName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function sharedVaultKey(name: string): string | undefined {
  const normalized = normalizeSharedVaultName(name);
  return normalized ? `${SHARED_VAULT_DIR}/${normalized}` : undefined;
}

function sanitizeCloudflareSandboxId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ResolvedVaultMount {
  source: string;
  target: string;
}

/** Resolved vault ready for use at runtime */
export interface ResolvedVault {
  userId: string;
  displayName: string;
  /** Absolute path to vault directory */
  dir: string;
  /** Absolute mount specs */
  mounts: ResolvedVaultMount[];
  /** Parsed from env file */
  env: Record<string, string>;
}

export interface VaultManager {
  /** Return true when a vault directory exists for this exact key. */
  hasEntry(key: string): boolean;
  /** Resolve vault for a user; returns undefined when no directory exists. */
  resolve(userId: string): ResolvedVault | undefined;
  /** Get sandbox config with credential injection for a user */
  getSandboxConfig(userId: string, baseConfig: SandboxConfig): SandboxConfig;
  /** List all vaults discovered under vaults/. */
  list(): ResolvedVault[];
  /** Check if the vaults directory exists. */
  isEnabled(): boolean;
  /** Merge environment variables into vaults/<key>/env and persist them to disk. */
  upsertEnv(key: string, env: Record<string, string>): void;
  /** Write a private file into vaults/<key>/ and ensure it is mounted into the sandbox. */
  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void;
  /** List named shared login profiles under vaults/shared/. */
  listSharedVaults(): string[];
  /** Delete a shared login profile's directory. Returns true when it existed. */
  deleteSharedVault(name: string): boolean;
  /** Copy a shared login profile's files into another vault directory. */
  copySharedVaultTo(
    name: string,
    targetKey: string,
  ): { filesCopied: number; envKeysCopied: number };
}

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
    const dir = join(this.vaultsDir, userId);
    if (!existsSync(dir)) return undefined;
    return this.buildResolved(userId);
  }

  getSandboxConfig(userId: string, baseConfig: SandboxConfig): SandboxConfig {
    if (baseConfig.type === "cloudflare") {
      return {
        type: "cloudflare",
        sandboxId: `${baseConfig.sandboxId}-${sanitizeCloudflareSandboxId(userId)}`,
      };
    }
    return baseConfig;
  }

  list(): ResolvedVault[] {
    if (!existsSync(this.vaultsDir)) return [];
    const keys = new Set<string>();
    for (const entry of readdirSync(this.vaultsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) keys.add(entry.name);
    }
    return Array.from(keys, (key) => this.buildResolved(key));
  }

  upsertEnv(key: string, env: Record<string, string>): void {
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

    let env: Record<string, string> = {};
    const envContent = readTextFileIfExists(join(dir, "env"));
    if (envContent !== undefined) {
      try {
        env = parseEnvFile(envContent);
      } catch (err) {
        console.error(`vault: failed to parse env file for "${key}":`, err);
        reportUserFacingError(err, {
          domain: "sandbox",
          surface: "vault_injection",
          operation: "parse_env",
          severity: "warning",
          context: { vaultKey: key, fatal: false },
        });
      }
    }

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
