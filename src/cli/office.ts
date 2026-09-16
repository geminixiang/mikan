/**
 * `mikan office` — inspect and claim conversation offices from the CLI.
 *
 *   mikan office list [--state-dir <dir>] [--workspace <dir>]
 *   mikan office claim <conversationId> <platform> [--state-dir <dir>] [--workspace <dir>]
 *   mikan office migrate-openconnector [--state-dir <dir>] [--workspace <dir>]
 *   mikan office migrate-events [--state-dir <dir>] [--workspace <dir>]
 *   mikan office migrate-door-policy [--state-dir <dir>] [--workspace <dir>]
 *
 * `migrate-door-policy` removes the retired `sandbox.image.workspaceMount` and
 * `sandbox.workspace` keys from the global and every office settings file
 * (ADR 0008). Only an explicit shared-support `private` visibility is carried
 * into `office.visibility`; nothing else is derived. Run it with the daemon
 * stopped.
 *
 * `migrate-events` moves legacy `<workspace>/events/*.json` records into the
 * owning office's host-only state (`conversations/<key>/events/`). Records
 * without an attributable, registered owner stay put and are reported. Run it
 * with the daemon stopped.
 *
 * `migrate-openconnector` converts legacy per-office
 * `open-connector-runtime-token.json` files into ordinary conversation
 * `mcpServers` entries for the current `OPENCONNECTOR_ENDPOINT`. Run it with
 * the daemon stopped.
 *
 * `claim` records which platform owns a legacy raw-id conversation directory
 * when several platforms are enabled and boot cannot infer ownership. The
 * daemon performs the actual move on its next start. Run it with the daemon
 * stopped so the directory is not moving under a live runtime.
 */
import { join, resolve } from "node:path";
import { assertPlatformName, OfficeRegistry } from "../office/index.js";
import { cliCommand, commandExitCode, nonEmptyValue, resolveStateDir } from "./arg-grammar.js";
import { readEnv, setEnvAliases } from "../env-manifest.js";
import { migrateLegacyOpenConnectorTokens } from "../harness/open-connector.js";
import { migrateLegacyWorkspaceEvents } from "../events/index.js";
import { migrateLegacyDoorPolicy } from "../settings/migrate.js";
import { createWorkspace } from "../office/index.js";

export function runOfficeCommand(argv: string[]): number {
  const command = cliCommand("mikan office")
    .description("Inspect conversation offices and claim legacy directories")
    .option("--state-dir <dir>", "State directory", nonEmptyValue)
    .option("--workspace <dir>", "Workspace directory", nonEmptyValue);
  let result = 1;
  command
    .command("list")
    .description("List registered offices")
    .action(() => {
      result = listOffices(resolveStateDir(argv));
    });
  command
    .command("claim <conversationId> <platform>")
    .description("Claim a legacy directory (stop the daemon first)")
    .action((conversationId: string, platform: string) => {
      const stateDir = resolveStateDir(argv);
      const { workspace } = command.opts<{ workspace?: string }>();
      result = claimOffice(stateDir, workspace ? resolve(workspace) : join(stateDir, "workspace"), [
        conversationId,
        platform,
      ]);
    });
  command
    .command("migrate-openconnector")
    .description(
      "Convert legacy OpenConnector token files into MCP settings (stop the daemon first)",
    )
    .action(() => {
      const stateDir = resolveStateDir(argv);
      const { workspace } = command.opts<{ workspace?: string }>();
      result = migrateOpenConnector(
        stateDir,
        workspace ? resolve(workspace) : join(stateDir, "workspace"),
      );
    });
  command
    .command("migrate-events")
    .description("Move legacy workspace event files into office state (stop the daemon first)")
    .action(() => {
      const stateDir = resolveStateDir(argv);
      const { workspace } = command.opts<{ workspace?: string }>();
      result = migrateEvents(
        stateDir,
        workspace ? resolve(workspace) : join(stateDir, "workspace"),
      );
    });
  command
    .command("migrate-door-policy")
    .description("Remove retired door-policy settings (stop the daemon first)")
    .action(() => {
      const stateDir = resolveStateDir(argv);
      const { workspace } = command.opts<{ workspace?: string }>();
      result = migrateDoorPolicy(
        stateDir,
        workspace ? resolve(workspace) : join(stateDir, "workspace"),
      );
    });
  try {
    command.parse(argv, { from: "user" });
    return result;
  } catch (error) {
    return commandExitCode(error, command);
  }
}

function listOffices(stateDir: string): number {
  const state = new OfficeRegistry(stateDir).getState();
  console.log(`Enabled platforms: ${state.enabledPlatforms.join(", ") || "(none)"}`);
  console.log(`Offices (${state.offices.length}):`);
  for (const office of state.offices) {
    console.log(`  ${office.platform}  ${office.conversationId}`);
  }
  const pending = state.migrations.filter((record) => record.status !== "committed");
  if (pending.length > 0) {
    console.log(`Pending migrations (${pending.length}):`);
    for (const record of pending) {
      const error = record.error ? `  (${record.error})` : "";
      console.log(`  ${record.status}  ${record.rawConversationId}${error}`);
    }
  }
  return 0;
}

function migrateDoorPolicy(stateDir: string, workspaceRoot: string): number {
  // Settings readers resolve the global file from the process state dir.
  setEnvAliases("STATE_DIR", stateDir);
  const report = migrateLegacyDoorPolicy(createWorkspace({ root: workspaceRoot, stateDir }));
  console.log(
    report.global.length > 0
      ? `Global settings: removed ${report.global.join(", ")}`
      : "Global settings: nothing to remove",
  );
  console.log(`Offices changed: ${report.conversations.length}`);
  for (const entry of report.conversations) {
    const carried = entry.visibility ? ` (kept as office.visibility=${entry.visibility})` : "";
    console.log(`  ${entry.key}: removed ${entry.removed.join(", ")}${carried}`);
  }
  for (const entry of report.skipped) console.log(`  skipped ${entry.key}: ${entry.reason}`);
  return report.skipped.length > 0 ? 1 : 0;
}

function migrateEvents(stateDir: string, workspaceRoot: string): number {
  try {
    const report = migrateLegacyWorkspaceEvents(createWorkspace({ root: workspaceRoot, stateDir }));
    console.log(`Migrated ${report.migrated.length} event file(s) into office state.`);
    for (const entry of report.migrated) console.log(`  ${entry.filename} -> ${entry.key}`);
    for (const entry of report.skipped) console.log(`  skipped ${entry.filename}: ${entry.reason}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function migrateOpenConnector(stateDir: string, workspaceRoot: string): number {
  const endpoint = readEnv("OPENCONNECTOR_ENDPOINT");
  if (!endpoint) {
    console.error("OPENCONNECTOR_ENDPOINT is not set; nothing to migrate to.");
    return 1;
  }
  try {
    const report = migrateLegacyOpenConnectorTokens(stateDir, endpoint, workspaceRoot);
    console.log(`Migrated ${report.migrated.length} office token file(s) into settings.json.`);
    for (const entry of report.skipped) {
      console.log(`  skipped ${entry.key}: ${entry.reason}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function claimOffice(stateDir: string, workspaceRoot: string, rest: string[]): number {
  const [rawConversationId, platform] = rest;
  if (!rawConversationId || !platform) return 1;
  try {
    const record = new OfficeRegistry(stateDir).prepareLegacyMigration({
      rawConversationId,
      sourceDir: join(workspaceRoot, rawConversationId),
      workspaceRoot,
      ownerPlatform: assertPlatformName(platform),
    });
    console.log(
      `Claimed ${record.rawConversationId} for ${record.ownerPlatform}; ` +
        "the daemon migrates the directory on its next start.",
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
