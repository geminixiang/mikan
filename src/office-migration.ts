import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as log from "./log.js";
import { isOfficeKey, officeKey, officeStateDir } from "./office-address.js";
import { legacyConversationCredentialKey } from "./sandbox/identity.js";
import type { OfficeRecord } from "./types.js";
import { OfficeRegistry } from "./office-registry.js";
import { migrateConversationVaultKeys } from "./vault/index.js";
import type { OfficeMigrationRecord, PlatformName } from "./types.js";

/**
 * Workspace-root entries that are shared infrastructure, never office dirs.
 * Mirrors the boot-time directory setup in main.ts.
 */
const RESERVED_WORKSPACE_ENTRIES = new Set(["skills", "events", "agents"]);

export interface OfficeMigrationRunSummary {
  /** Raw ids whose directories moved to the office-key layout this run. */
  migrated: string[];
  /** Raw ids whose interrupted moves were completed from the journal. */
  recovered: string[];
  /** Raw ids that still need an explicit owner (`mikan office claim`). */
  unowned: string[];
  /** Raw ids whose records are failed and need operator repair. */
  failed: string[];
  /** Raw ids whose conversation vault directories moved to office keys. */
  vaultKeysMigrated: string[];
  /** Raw ids whose legacy and office-key vault dirs both exist (manual merge). */
  vaultConflicts: string[];
  /** Raw ids whose host state dirs (settings, extensions, data) moved. */
  stateDirsMigrated: string[];
  /** Raw ids whose legacy and office-key state dirs both exist (manual merge). */
  stateDirConflicts: string[];
}

/**
 * Move every legacy raw-id office directory under the workspace root to the
 * canonical office-key layout, journaling each move through the office
 * registry so an interrupted run resumes instead of losing offices.
 *
 * The engine never guesses: with several enabled platforms an unowned raw
 * directory stays in place and is reported for `mikan office claim`. Callers
 * must treat a non-empty `unowned`/`failed` as fatal for daemon boot — after
 * the layout flip, an unmigrated legacy directory is invisible to the
 * runtime, which would silently present the conversation as empty.
 */
export function migrateLegacyOffices(options: {
  workspaceRoot: string;
  stateDir: string;
  enabledPlatforms: readonly PlatformName[];
}): OfficeMigrationRunSummary {
  const registry = new OfficeRegistry(options.stateDir);
  for (const platform of options.enabledPlatforms) registry.enablePlatform(platform);

  const summary: OfficeMigrationRunSummary = {
    migrated: [],
    recovered: [],
    unowned: [],
    failed: [],
    vaultKeysMigrated: [],
    vaultConflicts: [],
    stateDirsMigrated: [],
    stateDirConflicts: [],
  };

  recoverInterruptedMoves(registry, summary);
  claimAndMoveLegacyDirs(registry, options.workspaceRoot, summary);

  // Credential vaults are keyed by office too; the registry inventory (which
  // the directory moves above just extended) drives the same rename.
  const vaults = migrateConversationVaultKeys({
    stateDir: options.stateDir,
    offices: registry.getOffices(),
  });
  summary.vaultKeysMigrated = vaults.migrated;
  summary.vaultConflicts = vaults.conflicts;
  for (const rawConversationId of vaults.migrated) {
    log.logInfo(`[office] Migrated vault key to office key: ${rawConversationId}`);
  }

  migrateConversationStateDirs(registry, options.stateDir, summary);

  for (const record of registry.getState().migrations) {
    if (record.status === "needs-owner") summary.unowned.push(record.rawConversationId);
    else if (record.status === "failed") summary.failed.push(record.rawConversationId);
  }
  return summary;
}

/** Complete or fail every move the journal says was interrupted mid-rename. */
function recoverInterruptedMoves(
  registry: OfficeRegistry,
  summary: OfficeMigrationRunSummary,
): void {
  for (const record of registry.getState().migrations) {
    if (record.status !== "moving") continue;
    const targetDir = record.targetDir;
    if (!targetDir) {
      registry.markFailed(record.rawConversationId, "Moving record has no target directory");
      continue;
    }
    const sourceExists = pathExists(record.sourceDir);
    const targetExists = pathExists(targetDir);
    if (sourceExists && targetExists) {
      registry.markFailed(
        record.rawConversationId,
        "Both legacy source and office target exist; merge them manually",
      );
      continue;
    }
    if (!sourceExists && !targetExists) {
      registry.markFailed(
        record.rawConversationId,
        "Neither legacy source nor office target exists",
      );
      continue;
    }
    if (sourceExists) renameSync(record.sourceDir, targetDir);
    registry.markCommitted(record.rawConversationId);
    recordMigratedOffice(registry, record);
    summary.recovered.push(record.rawConversationId);
    log.logInfo(`[office] Recovered interrupted migration: ${record.rawConversationId}`);
  }
}

/** Scan the workspace root and move every claimable legacy office directory. */
function claimAndMoveLegacyDirs(
  registry: OfficeRegistry,
  workspaceRoot: string,
  summary: OfficeMigrationRunSummary,
): void {
  for (const rawConversationId of listLegacyOfficeDirs(workspaceRoot)) {
    const existing = registry.getMigration(rawConversationId);
    if (existing?.status === "committed") {
      // The move already happened; a raw-id dir with this name reappearing
      // afterwards is a different (or resurrected) office the runtime can no
      // longer see. Refusing to boot beats silently ignoring its data.
      throw new Error(
        `Legacy office directory reappeared after migration: ${join(workspaceRoot, rawConversationId)}`,
      );
    }
    if (existing?.status === "failed") continue; // reported via summary.failed

    const record = registry.prepareLegacyMigration({
      rawConversationId,
      sourceDir: join(workspaceRoot, rawConversationId),
      workspaceRoot,
    });
    if (record.status === "needs-owner") continue; // reported via summary.unowned

    const moving = registry.markMoving(rawConversationId);
    const targetDir = moving.targetDir;
    if (!targetDir) throw new Error("Moving office migration has no target directory");
    renameSync(moving.sourceDir, targetDir);
    registry.markCommitted(rawConversationId);
    recordMigratedOffice(registry, moving);
    summary.migrated.push(rawConversationId);
    log.logInfo(`[office] Migrated office directory: ${rawConversationId} -> ${targetDir}`);
  }
}

/**
 * Move each registered office's host state tree — settings.json, extensions,
 * extension-data, git checkouts — from `conversations/<rawId>` to
 * `conversations/<officeKey>` in one rename. Conflicts are reported for
 * manual merge, never clobbered.
 */
function migrateConversationStateDirs(
  registry: OfficeRegistry,
  stateDir: string,
  summary: OfficeMigrationRunSummary,
): void {
  for (const office of registry.getOffices()) {
    const legacyDir = join(stateDir, "conversations", office.conversationId);
    if (!existsSync(legacyDir)) continue;
    const targetDir = officeStateDir(stateDir, office);
    if (existsSync(targetDir)) {
      summary.stateDirConflicts.push(office.conversationId);
      continue;
    }
    renameSync(legacyDir, targetDir);
    summary.stateDirsMigrated.push(office.conversationId);
    log.logInfo(`[office] Migrated host state dir to office key: ${office.conversationId}`);
  }
}

/** A migrated office is an existing office; keep the directory enumerable. */
function recordMigratedOffice(registry: OfficeRegistry, record: OfficeMigrationRecord): void {
  if (!record.ownerPlatform) return;
  registry.recordOffice({
    platform: record.ownerPlatform,
    conversationId: record.rawConversationId,
  });
}

/**
 * Legacy office candidates: regular directories that are not reserved
 * infrastructure, not hidden, and not already office-key named. A symlink in
 * office position is refused outright — following it could move data from
 * outside the workspace root.
 *
 * A candidate must also look like a conversation office: every office that
 * ever saw a message has a `log.jsonl`, and every office that ran the agent
 * has `sessions/`. Trusted workspace roots legitimately accumulate other
 * directories — repos the agent cloned, build output — which are not offices
 * and must be neither renamed nor reported as unowned; they stay where they
 * are (an operator can still claim one explicitly via `mikan office claim`).
 */
function listLegacyOfficeDirs(workspaceRoot: string): string[] {
  const candidates: string[] = [];
  for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (RESERVED_WORKSPACE_ENTRIES.has(entry.name)) continue;
    if (isOfficeKey(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Workspace entry must not be a symlink: ${join(workspaceRoot, entry.name)}`);
    }
    if (!entry.isDirectory()) continue;
    if (!looksLikeConversationOffice(join(workspaceRoot, entry.name))) {
      log.logInfo(
        `[office] Skipping non-office workspace directory (no log.jsonl or sessions/): ${entry.name}`,
      );
      continue;
    }
    candidates.push(entry.name);
  }
  return candidates.toSorted();
}

function looksLikeConversationOffice(dir: string): boolean {
  return existsSync(join(dir, "log.jsonl")) || existsSync(join(dir, "sessions"));
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Operator-facing boot failure for offices the engine may not move itself. */
export function formatUnmigratedOfficesError(summary: OfficeMigrationRunSummary): string {
  const lines = ["Conversation office migration cannot complete:"];
  if (summary.unowned.length > 0) {
    lines.push(
      "",
      "These legacy conversation directories have no owning platform (several",
      "platforms are enabled, so ownership cannot be inferred):",
      ...summary.unowned.map((id) => `  - ${id}`),
      "",
      "Assign each one with:",
      "  mikan office claim <conversationId> <platform>",
    );
  }
  if (summary.failed.length > 0) {
    lines.push(
      "",
      "These migrations previously failed and need manual repair (see",
      "office-registry.json in the state dir for each error):",
      ...summary.failed.map((id) => `  - ${id}`),
    );
  }
  if (summary.vaultConflicts.length > 0) {
    lines.push(
      "",
      "These conversations have credentials under both the legacy and the",
      "office-key vault directory; merge them manually under <state-dir>/vaults:",
      ...summary.vaultConflicts.map((id) => `  - ${id}`),
    );
  }
  if (summary.stateDirConflicts.length > 0) {
    lines.push(
      "",
      "These conversations have host state under both the legacy and the",
      "office-key directory; merge them manually under <state-dir>/conversations:",
      ...summary.stateDirConflicts.map((id) => `  - ${id}`),
    );
  }
  return lines.join("\n");
}

/**
 * Bind-spec translator for the container layout migration: rewrites every
 * host path the office migration renamed — workspace dirs, per-conversation
 * state trees, conversation vaults — and the guest workspace segment, using
 * the registry's office inventory as the raw-id ↔ office mapping. Specs that
 * reference none of the renamed paths come back unchanged, which is also how
 * an already-migrated container is recognized.
 */
function replacePrefix(path: string, pairs: Array<[string, string]>): string {
  for (const [oldPrefix, newPrefix] of pairs) {
    if (path === oldPrefix) return newPrefix;
    if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  }
  return path;
}

export function buildContainerBindTranslator(options: {
  offices: readonly OfficeRecord[];
  workspaceRoot: string;
  stateDir: string;
}): (bindSpec: string) => string {
  const hostPairs: Array<[string, string]> = [];
  const guestPairs: Array<[string, string]> = [];
  for (const office of options.offices) {
    const key = officeKey(office);
    const rawId = office.conversationId;
    hostPairs.push([join(options.workspaceRoot, rawId), join(options.workspaceRoot, key)]);
    hostPairs.push([
      join(options.stateDir, "conversations", rawId),
      officeStateDir(options.stateDir, office),
    ]);
    hostPairs.push([
      join(options.stateDir, "vaults", legacyConversationCredentialKey(rawId)),
      join(options.stateDir, "vaults", key),
    ]);
    guestPairs.push([`/workspace/${rawId}`, `/workspace/${key}`]);
  }

  return (bindSpec: string): string => {
    const readOnly = bindSpec.endsWith(":ro");
    const spec = readOnly ? bindSpec.slice(0, -3) : bindSpec;
    const separator = spec.indexOf(":");
    if (separator === -1) return bindSpec;
    const source = replacePrefix(spec.slice(0, separator), hostPairs);
    const target = replacePrefix(spec.slice(separator + 1), guestPairs);
    return `${source}:${target}${readOnly ? ":ro" : ""}`;
  };
}
