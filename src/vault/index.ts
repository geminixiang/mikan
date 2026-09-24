import type { Dirent } from "node:fs";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { officeKey } from "../office/index.js";
import { legacyConversationCredentialKey } from "../sandbox/identity.js";
import { guestHomePath } from "../sandbox/layout.js";
import type { OfficeAddress } from "../types.js";
import { atomicWritePrivateFile, isRecord, readTextFileIfExists } from "../file-guards.js";
import { reportUserFacingError } from "../observability/index.js";
import type { SandboxConfig, SandboxCredentialCapabilities } from "../sandbox/types.js";

const PRIVATE_DIR_MODE = 0o700;
const SHARED_VAULT_DIR = "shared";
const LEGACY_MOUNT_TARGETS_FILE = ".mount-targets.json";
const MOUNT_TARGETS_DIR = "vault-mount-targets";
const RESERVED_VAULT_DIRS = new Set([SHARED_VAULT_DIR, "extensions"]);

function normalizeSharedVaultName(name: string): string | undefined {
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

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split(/\r\n|\r|\n/)) {
    const entry = parseEnvLine(line);
    if (entry) env[entry[0]] = entry[1];
  }
  return env;
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) return undefined;

  const key = trimmed.slice(0, eqIndex).trim();
  if (!key) return undefined;
  return [key, unquoteEnvValue(trimmed.slice(eqIndex + 1))];
}

function unquoteEnvValue(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}

export class FileVaultManager implements VaultManager {
  private readonly vaultsDir: string;
  private readonly mountTargetsDir: string;

  constructor(stateDir: string) {
    this.vaultsDir = join(stateDir, "vaults");
    this.mountTargetsDir = join(stateDir, MOUNT_TARGETS_DIR);
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
    rmSync(this.mountTargetsPath(key), { force: true });
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
    assertNoLegacyMountTargetsCollision(sourceDir);
    assertNoLegacyMountTargetsCollision(targetDir);
    const sourceTargets = readMountTargets(this.mountTargetsPath(sourceKey));
    const targetTargets = readMountTargets(this.mountTargetsPath(targetKey));
    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(targetDir);
    const result = copyVaultDir(sourceDir, targetDir);
    writeMountTargets(this.mountTargetsPath(targetKey), {
      ...targetTargets,
      ...sourceTargets,
    });
    return result;
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

  deleteEnvKey(key: string, envKey: string): boolean {
    if (!isSafeVaultKey(key)) throw new Error(`vault: invalid vault key: ${key}`);
    const envPath = join(this.vaultsDir, key, "env");
    const existingContent = readTextFileIfExists(envPath);
    if (existingContent === undefined) return false;
    const existing = parseEnvFile(existingContent);
    if (!(envKey in existing)) return false;
    delete existing[envKey];
    const content =
      Object.entries(existing)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join("\n") + "\n";
    atomicWritePrivateFile(envPath, content);
    return true;
  }

  upsertFile(key: string, relativePath: string, content: string, targetPath?: string): void {
    if (!isSafeVaultKey(key)) throw new Error(`vault: invalid vault key: ${key}`);
    const normalizedPath = normalizeVaultRelativePath(relativePath);
    const normalizedTarget = normalizeVaultTargetPath(targetPath);
    if (
      !normalizedPath ||
      normalizedPath === LEGACY_MOUNT_TARGETS_FILE ||
      (targetPath !== undefined && !normalizedTarget)
    ) {
      throw new Error(`vault: invalid relative secret file path for "${key}": ${relativePath}`);
    }

    const dir = join(this.vaultsDir, key);
    const filePath = join(dir, normalizedPath);
    assertNoLegacyMountTargetsCollision(dir);

    ensurePrivateDir(this.vaultsDir);
    ensurePrivateDir(dir);
    const parentDir = dirname(filePath);
    if (parentDir !== dir) ensurePrivateDir(parentDir);
    atomicWritePrivateFile(filePath, content);
    updateMountTarget(this.mountTargetsPath(key), normalizedPath, normalizedTarget);
  }

  private buildResolved(key: string): ResolvedVault {
    const dir = join(this.vaultsDir, key);
    assertNoLegacyMountTargetsCollision(dir);
    const mounts = resolveMountsFromDir(dir, readMountTargets(this.mountTargetsPath(key)));

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

  private mountTargetsPath(key: string): string {
    return join(this.mountTargetsDir, `${key}.json`);
  }
}

function resolveMountsFromDir(
  dir: string,
  explicitTargets: Record<string, string>,
): ResolvedVaultMount[] {
  if (!existsSync(dir)) return [];

  const mounts: ResolvedVaultMount[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "env") continue;
    const source = join(dir, entry.name);
    const inferredTarget = inferredVaultTargetPath(entry.name);
    if (!inferredTarget) continue;

    const explicitTarget = Object.hasOwn(explicitTargets, entry.name)
      ? explicitTargets[entry.name]
      : undefined;
    if (explicitTarget) {
      mounts.push({ source, target: explicitTarget });
      continue;
    }

    const nestedPrefix = `${entry.name}/`;
    const hasExplicitDescendant = Object.keys(explicitTargets).some((relativePath) =>
      relativePath.startsWith(nestedPrefix),
    );
    if (!entry.isDirectory() || !hasExplicitDescendant) {
      mounts.push({ source, target: inferredTarget });
      continue;
    }
    mounts.push(...resolveNestedMounts(dir, entry.name, inferredTarget, explicitTargets));
  }
  return mounts;
}

function resolveNestedMounts(
  rootDir: string,
  relativeDir: string,
  targetDir: string,
  explicitTargets: Record<string, string>,
): ResolvedVaultMount[] {
  const mounts: ResolvedVaultMount[] = [];
  for (const entry of readdirSync(join(rootDir, relativeDir), { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    const source = join(rootDir, relativePath);
    const inferredTarget = `${targetDir}/${entry.name}`;
    const explicitTarget = Object.hasOwn(explicitTargets, relativePath)
      ? explicitTargets[relativePath]
      : undefined;
    if (explicitTarget) {
      mounts.push({ source, target: explicitTarget });
      continue;
    }

    const nestedPrefix = `${relativePath}/`;
    const hasExplicitDescendant = Object.keys(explicitTargets).some((candidate) =>
      candidate.startsWith(nestedPrefix),
    );
    if (!entry.isDirectory() || !hasExplicitDescendant) {
      mounts.push({ source, target: inferredTarget });
      continue;
    }
    mounts.push(...resolveNestedMounts(rootDir, relativePath, inferredTarget, explicitTargets));
  }
  return mounts;
}

function assertNoLegacyMountTargetsCollision(dir: string): void {
  const path = join(dir, LEGACY_MOUNT_TARGETS_FILE);
  if (existsSync(path)) {
    throw new Error(`vault: reserved mount metadata filename collision: ${path}`);
  }
}

function readMountTargets(path: string): Record<string, string> {
  const raw = readTextFileIfExists(path);
  if (raw === undefined) return Object.create(null) as Record<string, string>;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`vault: invalid mount target metadata: ${path}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`vault: invalid mount target metadata: ${path}`);

  const targets = Object.create(null) as Record<string, string>;
  for (const [relativePath, targetPath] of Object.entries(value)) {
    const normalizedPath = normalizeVaultRelativePath(relativePath);
    const normalizedTarget =
      typeof targetPath === "string" ? normalizeVaultTargetPath(targetPath) : undefined;
    if (normalizedPath !== relativePath || !normalizedTarget || normalizedTarget !== targetPath) {
      throw new Error(`vault: invalid mount target metadata: ${path}`);
    }
    targets[relativePath] = targetPath;
  }
  return targets;
}

function updateMountTarget(path: string, relativePath: string, targetPath?: string): void {
  const targets = readMountTargets(path);
  if (targetPath === undefined) delete targets[relativePath];
  else targets[relativePath] = targetPath;
  writeMountTargets(path, targets);
}

function writeMountTargets(path: string, targets: Record<string, string>): void {
  if (Object.keys(targets).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  ensurePrivateDir(dirname(path));
  atomicWritePrivateFile(path, `${JSON.stringify(targets, null, 2)}\n`);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(path, PRIVATE_DIR_MODE);
}

interface VaultCopyCounts {
  filesCopied: number;
  envKeysCopied: number;
}

function copyVaultDir(sourceDir: string, targetDir: string): VaultCopyCounts {
  const total: VaultCopyCounts = { filesCopied: 0, envKeysCopied: 0 };
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const counts = copyVaultEntry(sourceDir, targetDir, entry);
    total.filesCopied += counts.filesCopied;
    total.envKeysCopied += counts.envKeysCopied;
  }
  return total;
}

function copyVaultEntry(sourceDir: string, targetDir: string, entry: Dirent): VaultCopyCounts {
  const sourcePath = join(sourceDir, entry.name);
  const targetPath = join(targetDir, entry.name);

  if (entry.name === "env" && entry.isFile()) {
    return { filesCopied: 0, envKeysCopied: mergeVaultEnvFile(sourcePath, targetPath) };
  }
  if (entry.isDirectory()) {
    ensurePrivateDir(targetPath);
    return copyVaultDir(sourcePath, targetPath);
  }
  if (!entry.isFile()) return { filesCopied: 0, envKeysCopied: 0 };

  copyFileSync(sourcePath, targetPath);
  chmodSync(targetPath, 0o600);
  return { filesCopied: 1, envKeysCopied: 0 };
}

function mergeVaultEnvFile(sourcePath: string, targetPath: string): number {
  const sourceEnv = parseEnvFile(readTextFileIfExists(sourcePath) ?? "");
  const targetEnv = parseEnvFile(readTextFileIfExists(targetPath) ?? "");
  const merged = { ...targetEnv, ...sourceEnv };
  const content =
    Object.entries(merged)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([envKey, value]) => `${envKey}=${value}`)
      .join("\n") + "\n";
  atomicWritePrivateFile(targetPath, content);
  return Object.keys(sourceEnv).length;
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
  return guestHomePath(normalized);
}

function inferredVaultTargetPath(relativePath: string): string | undefined {
  const normalized = normalizeVaultRelativePath(relativePath);
  if (!normalized) return undefined;

  if (normalized === "gws.json") {
    return guestHomePath(".config/gws/credentials.json");
  }
  if (normalized === "gcloud-adc.json") {
    return guestHomePath(".config/gcloud/application_default_credentials.json");
  }
  if (normalized === ".ssh" || normalized.startsWith(".ssh/")) {
    return guestHomePath(".ssh");
  }
  if (normalized === ".kube" || normalized.startsWith(".kube/")) {
    return guestHomePath(".kube");
  }
  if (normalized === ".config/gh" || normalized.startsWith(".config/gh/")) {
    return guestHomePath(".config/gh");
  }

  return defaultVaultTargetPath(normalized);
}

export function migrateConversationVaultKeys(options: {
  stateDir: string;
  offices: readonly OfficeAddress[];
}): { migrated: string[]; conflicts: string[] } {
  const vaultsDir = join(options.stateDir, "vaults");
  const migrated: string[] = [];
  const conflicts: string[] = [];
  if (!existsSync(vaultsDir)) return { migrated, conflicts };

  const officesByConversationId = new Map<string, OfficeAddress[]>();
  for (const office of options.offices) {
    const offices = officesByConversationId.get(office.conversationId) ?? [];
    offices.push(office);
    officesByConversationId.set(office.conversationId, offices);
  }
  for (const [conversationId, offices] of officesByConversationId) {
    const legacyDir = join(vaultsDir, legacyConversationCredentialKey(conversationId));
    if (!existsSync(legacyDir)) continue;
    if (offices.length !== 1) {
      conflicts.push(conversationId);
      continue;
    }

    const office = offices[0];
    if (!office) throw new Error(`vault: missing office owner for ${conversationId}`);
    const targetDir = join(vaultsDir, officeKey(office));
    if (existsSync(targetDir)) {
      conflicts.push(conversationId);
      continue;
    }
    renameSync(legacyDir, targetDir);
    migrated.push(conversationId);
  }
  return { migrated, conflicts };
}

export type { VaultInjection } from "./types.js";
import type { VaultInjection } from "./types.js";

function resolveExistingMounts(
  vault: ResolvedVault | undefined,
  sandboxType: SandboxConfig["type"],
  address: OfficeAddress,
): ResolvedVaultMount[] {
  const mounts: ResolvedVaultMount[] = [];
  for (const mount of vault?.mounts ?? []) {
    if (!existsSync(mount.source)) {
      reportUserFacingError(new Error("Vault mount source is missing"), {
        domain: "sandbox",
        surface: "vault_injection",
        operation: "resolve_mounts",
        severity: "warning",
        context: {
          sandboxType,
          conversationId: address.conversationId,
          target: mount.target,
          hasVault: Boolean(vault),
        },
      });
      continue;
    }
    mounts.push({ source: mount.source, target: mount.target });
  }
  return mounts;
}

export function resolveVaultInjection(options: {
  vault: ResolvedVault | undefined;
  capabilities: SandboxCredentialCapabilities;
  sandboxType: SandboxConfig["type"];
  address: OfficeAddress;
}): VaultInjection {
  const { vault, capabilities, sandboxType, address } = options;
  if (vault && vault.mounts.length > 0 && !capabilities.fileMounts) {
    throw new Error(`Sandbox type "${sandboxType}" does not support vault file mounts`);
  }

  const mounts = resolveExistingMounts(vault, sandboxType, address);

  const env =
    capabilities.env && vault && Object.keys(vault.env).length > 0 ? vault.env : undefined;
  return { ...(env ? { env } : {}), mounts };
}

export const disabledVaultManager: VaultManager = {
  isEnabled: () => false,
  hasEntry: () => false,
  resolve: () => undefined,
  list: () => [],
  listSharedVaults: () => [],
  deleteSharedVault: () => false,
  copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
  upsertEnv: () => {
    throw new Error("Vault not configured");
  },
  deleteEnvKey: () => {
    throw new Error("Vault not configured");
  },
  upsertFile: () => {
    throw new Error("Vault not configured");
  },
};
