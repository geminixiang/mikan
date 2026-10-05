import { join } from "node:path";
import { atomicWritePrivateFile, readTextFileIfExists } from "../file-guards.js";
import type { SandboxConfig } from "../sandbox/types.js";
import { isRecord } from "../unknown-values.js";
import { actorVaultsMigration } from "./actor-vaults.js";
import { conversationSettingsMigration } from "./conversation-settings.js";
import { modelsJsonMigration } from "./models-json.js";
import { officeLayoutMigration } from "./office-layout.js";
import { officeSessionsMigration } from "./office-sessions.js";
import { sandboxContainersMigration } from "./sandbox-containers.js";
import { sessionsSqliteMigration } from "./sessions-sqlite.js";
import type { AppliedMigration, Migration, MigrationContext } from "./types.js";
import { workspaceEventsMigration } from "./workspace-events.js";

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  officeLayoutMigration,
  actorVaultsMigration,
  conversationSettingsMigration,
  workspaceEventsMigration,
  sandboxContainersMigration,
  modelsJsonMigration,
  officeSessionsMigration,
  sessionsSqliteMigration,
]);

const RECORD_FILENAME = "migrations.json";

function recordPath(stateDir: string): string {
  return join(stateDir, RECORD_FILENAME);
}

export function readAppliedMigrations(stateDir: string): readonly AppliedMigration[] {
  const path = recordPath(stateDir);
  const raw = readTextFileIfExists(path);
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid migration record JSON at ${path}`, { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.applied)) {
    throw new Error(`Invalid migration record at ${path}`);
  }
  return value.applied.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.appliedAt !== "string") {
      throw new Error(`Invalid migration record entry at ${path}`);
    }
    return { id: entry.id, appliedAt: entry.appliedAt };
  });
}

function writeAppliedMigrations(stateDir: string, applied: readonly AppliedMigration[]): void {
  atomicWritePrivateFile(recordPath(stateDir), `${JSON.stringify({ applied }, null, 2)}\n`);
}

export function pendingMigrations(
  stateDir: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Migration[] {
  const applied = new Set(readAppliedMigrations(stateDir).map((entry) => entry.id));
  return migrations.filter((migration) => !applied.has(migration.id));
}

export function recordAllMigrations(
  stateDir: string,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const applied = [...readAppliedMigrations(stateDir)];
  const appliedAt = new Date().toISOString();
  for (const migration of pendingMigrations(stateDir, migrations)) {
    applied.push({ id: migration.id, appliedAt });
  }
  writeAppliedMigrations(stateDir, applied);
}

export async function runMigrations(
  context: MigrationContext,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  const applied = [...readAppliedMigrations(context.stateDir)];
  const ran: string[] = [];
  for (const migration of pendingMigrations(context.stateDir, migrations)) {
    context.report(`${migration.id}: ${migration.summary}`);
    await migration.run(context);
    ran.push(migration.id);
    if (context.dryRun) continue;
    applied.push({ id: migration.id, appliedAt: new Date().toISOString() });
    writeAppliedMigrations(context.stateDir, applied);
  }
  return ran;
}

function sandboxSpec(sandbox: SandboxConfig): string {
  switch (sandbox.type) {
    case "host":
      return "host";
    case "container":
      return `container:${sandbox.container}`;
    case "image":
      return `image:${sandbox.image}`;
    case "cloudflare":
      return `cloudflare:${sandbox.sandboxId}`;
  }
}

export function formatPendingMigrations(options: {
  pending: readonly Migration[];
  stateDir: string;
  workspaceRoot: string;
  sandbox: SandboxConfig;
}): string {
  const { pending, stateDir, workspaceRoot, sandbox } = options;
  const command = `mikan migrate --state-dir ${stateDir} --workspace ${workspaceRoot} --sandbox ${sandboxSpec(sandbox)}`;
  return [
    "State needs migration before mikan can start:",
    ...pending.map((migration) => `  - ${migration.id}: ${migration.summary}`),
    "",
    `With mikan stopped, preview with \`${command} --dry-run\`, then run \`${command}\`.`,
  ].join("\n");
}
