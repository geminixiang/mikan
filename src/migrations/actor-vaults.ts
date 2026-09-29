import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isOfficeKey } from "../office/index.js";
import { containerCredentialKey, userCredentialKey } from "../sandbox/identity.js";
import type { Migration, MigrationContext } from "./types.js";

const SHARED_VAULTS_DIR = "shared";
const CURRENT_IDENTITY_KEY = /^[a-z0-9-]+-[a-f0-9]{12}$/;

function legacyVaultRenames(context: MigrationContext, vaultsDir: string): Array<[string, string]> {
  const { sandbox } = context;
  if (sandbox.type === "container") {
    const legacy = `container-${sandbox.container}`;
    return existsSync(join(vaultsDir, legacy))
      ? [[legacy, containerCredentialKey(sandbox.container)]]
      : [];
  }
  if (sandbox.type !== "host") return [];
  return readdirSync(vaultsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== SHARED_VAULTS_DIR &&
        !entry.name.startsWith(".") &&
        !isOfficeKey(entry.name) &&
        !CURRENT_IDENTITY_KEY.test(entry.name),
    )
    .map((entry): [string, string] => [entry.name, userCredentialKey(entry.name)]);
}

export const actorVaultsMigration: Migration = Object.freeze({
  id: "0002-actor-vaults",
  summary: "rename host (per-user) and container vaults to hashed identity keys",
  async run(context: MigrationContext): Promise<void> {
    const vaultsDir = join(context.stateDir, "vaults");
    if (!existsSync(vaultsDir)) return;
    for (const [legacy, current] of legacyVaultRenames(context, vaultsDir)) {
      const target = join(vaultsDir, current);
      if (existsSync(target)) {
        throw new Error(`Both vaults/${legacy} and vaults/${current} exist; merge them first`);
      }
      context.report(`  vault ${legacy} -> ${current}`);
      if (!context.dryRun) renameSync(join(vaultsDir, legacy), target);
    }
  },
});
