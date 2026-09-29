import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  createOfficeAddress,
  isOfficeKey,
  OFFICE_LOG_FILENAME,
  officeDir,
  officeKey,
  OfficeRegistry,
  RESERVED_WORKSPACE_NAMES,
} from "../office/index.js";
import type { OfficeAddress, PlatformName } from "../types.js";
import type { Migration, MigrationContext } from "./types.js";

const LEGACY_ID_FORMATS: Readonly<Record<PlatformName, RegExp>> = Object.freeze({
  slack: /^[A-Z][A-Z0-9]*$/,
  telegram: /^-?\d+$/,
  discord: /^\d+$/,
  github: /^$/,
});

export function legacyResourceKey(conversationId: string): string {
  const sanitized = conversationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function listLegacyOfficeDirs(workspaceRoot: string): string[] {
  if (!existsSync(workspaceRoot)) return [];
  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !RESERVED_WORKSPACE_NAMES.has(entry.name) &&
        !isOfficeKey(entry.name) &&
        (existsSync(join(workspaceRoot, entry.name, OFFICE_LOG_FILENAME)) ||
          existsSync(join(workspaceRoot, entry.name, "sessions"))),
    )
    .map((entry) => entry.name)
    .toSorted();
}

function resolveOwner(conversationId: string, context: MigrationContext): PlatformName | undefined {
  const explicit = context.owners.get(conversationId);
  if (explicit) return explicit;
  const candidates = context.enabledPlatforms.filter((platform) =>
    LEGACY_ID_FORMATS[platform].test(conversationId),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveAddresses(ids: readonly string[], context: MigrationContext): OfficeAddress[] {
  const addresses: OfficeAddress[] = [];
  const unowned: string[] = [];
  for (const id of ids) {
    const platform = resolveOwner(id, context);
    if (platform) addresses.push(createOfficeAddress(platform, id));
    else unowned.push(id);
  }
  if (unowned.length > 0) {
    throw new Error(
      [
        "These conversation directories match no single enabled platform:",
        ...unowned.map((id) => `  - ${id}`),
        "Enable the owning platform's token, or name it with --owner <conversationId>=<platform>.",
      ].join("\n"),
    );
  }
  return addresses;
}

function moveVault(context: MigrationContext, address: OfficeAddress): void {
  const vaultsDir = join(context.stateDir, "vaults");
  const source = join(vaultsDir, legacyResourceKey(address.conversationId));
  if (!existsSync(source)) return;
  const target = join(vaultsDir, officeKey(address));
  if (existsSync(target)) {
    throw new Error(`Both a legacy and an office vault exist; merge ${source} into ${target}`);
  }
  context.report(`  vault ${legacyResourceKey(address.conversationId)} -> ${officeKey(address)}`);
  if (!context.dryRun) renameSync(source, target);
}

function moveOffice(context: MigrationContext, address: OfficeAddress): void {
  const source = join(context.workspaceRoot, address.conversationId);
  const target = officeDir(context.workspaceRoot, address);
  if (lstatSync(source).isSymbolicLink()) {
    throw new Error(`Conversation directory must not be a symlink: ${source}`);
  }
  if (existsSync(target)) {
    throw new Error(`Both a legacy and an office directory exist; merge ${source} into ${target}`);
  }
  context.report(`  office ${address.conversationId} -> ${officeKey(address)}`);
  if (!context.dryRun) new OfficeRegistry(context.stateDir).recordOffice(address);
  moveVault(context, address);
  if (!context.dryRun) renameSync(source, target);
}

export const officeLayoutMigration: Migration = Object.freeze({
  id: "0001-office-layout",
  summary: "move conversation directories and their vaults to office keys",
  async run(context: MigrationContext): Promise<void> {
    const addresses = resolveAddresses(listLegacyOfficeDirs(context.workspaceRoot), context);
    for (const address of addresses) moveOffice(context, address);
  },
});
