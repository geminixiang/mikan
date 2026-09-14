/**
 * `mikan office` — inspect and claim conversation offices from the CLI.
 *
 *   mikan office list [--state-dir <dir>] [--workspace <dir>]
 *   mikan office claim <conversationId> <platform> [--state-dir <dir>] [--workspace <dir>]
 *
 * `claim` records which platform owns a legacy raw-id conversation directory
 * when several platforms are enabled and boot cannot infer ownership. The
 * daemon performs the actual move on its next start. Run it with the daemon
 * stopped so the directory is not moving under a live runtime.
 */
import { join, resolve } from "node:path";
import { assertPlatformName, OfficeRegistry } from "../office/index.js";
import { cliCommand, commandExitCode, nonEmptyValue, resolveStateDir } from "./arg-grammar.js";

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
