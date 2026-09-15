/**
 * `mikan office` — inspect and claim conversation offices from the CLI.
 *
 *   mikan office list [--state-dir <dir>] [--workspace <dir>]
 *   mikan office claim <conversationId> <platform> [--state-dir <dir>] [--workspace <dir>]
 *   mikan office migrate-openconnector [--state-dir <dir>] [--workspace <dir>]
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
import { readEnv } from "../env-manifest.js";
import { migrateLegacyOpenConnectorTokens } from "../harness/open-connector.js";

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
