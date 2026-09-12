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
import { reportUnknownFlag, resolveStateDir, scanArgs } from "./arg-grammar.js";

const USAGE = `Usage:
  mikan office list [--state-dir <dir>] [--workspace <dir>]
  mikan office claim <conversationId> <platform> [--state-dir <dir>] [--workspace <dir>]`;

export function runOfficeCommand(argv: string[]): number {
  const scan = scanArgs(argv, {
    values: ["--workspace", "--state-dir"], // --state-dir is read by resolveStateDir
  });
  if (scan.unknown) return reportUnknownFlag(scan.unknown, USAGE);

  const stateDir = resolveStateDir(argv);
  const workspaceArg = scan.values.get("--workspace");
  const workspaceRoot = workspaceArg ? resolve(workspaceArg) : join(stateDir, "workspace");
  const [action, ...rest] = scan.positionals;

  if (action === "list") return listOffices(stateDir);
  if (action === "claim") return claimOffice(stateDir, workspaceRoot, rest);
  console.error(USAGE);
  return 1;
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
  if (!rawConversationId || !platform) {
    console.error(USAGE);
    return 1;
  }
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
