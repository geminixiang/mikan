import { join, resolve } from "node:path";
import { findPi084SessionFiles, migratePi084SessionFile } from "../sessions/migrate-pi-084.js";
import { findV3SessionFiles, migrateSessionFile } from "../sessions/migrate-v3.js";
import { cliCommand, commandExitCode, nonEmptyValue, resolveStateDir } from "./arg-grammar.js";

interface Candidate {
  file: string;
  format: "v3" | "pi-084";
}

export async function runSessionsCommand(argv: string[]): Promise<number> {
  const command = cliCommand("mikan sessions")
    .description("Session-file maintenance (stop the daemon first)")
    .option("--state-dir <dir>", "State directory", nonEmptyValue)
    .option("--workspace <dir>", "Workspace directory", nonEmptyValue);
  let result = 1;
  command
    .command("migrate")
    .description("Migrate legacy sessions, preserving backups")
    .option("--dry-run", "Preview migration without writing")
    .action(async (options: { dryRun?: boolean }) => {
      const { workspace } = command.opts<{ workspace?: string }>();
      const workspaceRoot = workspace
        ? resolve(workspace)
        : join(resolveStateDir(argv), "workspace");
      result = await migrateWorkspace(workspaceRoot, options.dryRun ?? false);
    });
  try {
    await command.parseAsync(argv, { from: "user" });
    return result;
  } catch (error) {
    return commandExitCode(error, command);
  }
}

async function migrateWorkspace(workspaceRoot: string, dryRun: boolean): Promise<number> {
  const candidates = findCandidates(workspaceRoot);
  if (candidates.length === 0) {
    console.log(`No legacy session files found under ${workspaceRoot}`);
    return 0;
  }

  console.log(`Found ${candidates.length} legacy session file(s) under ${workspaceRoot}`);
  const { migrated, failed } = await migrateCandidates(candidates, dryRun);
  console.log(
    dryRun
      ? `Dry run: ${migrated} file(s) would be migrated, ${failed} failed to read.`
      : `Migrated ${migrated} file(s), ${failed} failure(s). Originals kept as *.v3.bak or *.pi-084.bak.`,
  );
  return failed === 0 ? 0 : 1;
}

function findCandidates(workspaceRoot: string): Candidate[] {
  return [
    ...findV3SessionFiles(workspaceRoot).map((file) => ({ file, format: "v3" as const })),
    ...findPi084SessionFiles(workspaceRoot).map((file) => ({ file, format: "pi-084" as const })),
  ].toSorted((left, right) => left.file.localeCompare(right.file));
}

async function migrateCandidates(
  candidates: readonly Candidate[],
  dryRun: boolean,
): Promise<{ migrated: number; failed: number }> {
  let migrated = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const outcome = await migrateCandidate(candidate, dryRun);
    if (outcome === "migrated") migrated++;
    if (outcome === "failed") failed++;
  }
  return { migrated, failed };
}

async function migrateCandidate(
  { file, format }: Candidate,
  dryRun: boolean,
): Promise<"migrated" | "skipped" | "failed"> {
  try {
    const result =
      format === "v3"
        ? await migrateSessionFile(file, { dryRun })
        : await migratePi084SessionFile(file, { dryRun });
    if (result.status !== "migrated") return "skipped";
    console.log(`${dryRun ? "would migrate" : "migrated"}  ${file}`);
    return "migrated";
  } catch (error) {
    const cause = error instanceof Error && error.cause ? ` (${String(error.cause)})` : "";
    console.error(`FAILED     ${file}: ${error instanceof Error ? error.message : error}${cause}`);
    return "failed";
  }
}
