/**
 * `mikan sessions` — session-file maintenance from the CLI.
 *
 *   mikan sessions migrate [--state-dir <dir>] [--workspace <dir>] [--dry-run]
 *
 * `migrate` rewrites legacy mikan v3 and Pi 0.84-generation v4 sessions to
 * Pi's current JSONL v4 storage schema. Run it with the daemon stopped. Each
 * candidate is verified before atomic replacement, and the original remains
 * beside it as `<file>.v3.bak` or `<file>.pi-084.bak`.
 */
import { join, resolve } from "node:path";
import { findPi084SessionFiles, migratePi084SessionFile } from "../sessions/migrate-pi-084.js";
import { findV3SessionFiles, migrateSessionFile } from "../sessions/migrate-v3.js";
import { resolveStateDir, takeValueFlag } from "./arg-grammar.js";

const USAGE = `Usage:
  mikan sessions migrate [--state-dir <dir>] [--workspace <dir>] [--dry-run]`;

export async function runSessionsCommand(argv: string[]): Promise<number> {
  const stateDir = resolveStateDir(argv);
  let workspaceArg: string | undefined;
  let dryRun = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let taken;
    if ((taken = takeValueFlag(argv, i, "--workspace"))) {
      workspaceArg = taken.value;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(argv, i, "--state-dir"))) {
      i = taken.lastIndex; // consumed by resolveStateDir above
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown flag: ${arg}\n${USAGE}`);
      return 1;
    } else {
      positional.push(arg);
    }
  }

  if (positional[0] !== "migrate" || positional.length !== 1) {
    console.error(USAGE);
    return 1;
  }

  const workspaceRoot = workspaceArg ? resolve(workspaceArg) : join(stateDir, "workspace");
  const candidates = [
    ...findV3SessionFiles(workspaceRoot).map((file) => ({ file, format: "v3" as const })),
    ...findPi084SessionFiles(workspaceRoot).map((file) => ({ file, format: "pi-084" as const })),
  ].toSorted((left, right) => left.file.localeCompare(right.file));
  if (candidates.length === 0) {
    console.log(`No legacy session files found under ${workspaceRoot}`);
    return 0;
  }

  console.log(`Found ${candidates.length} legacy session file(s) under ${workspaceRoot}`);
  let migrated = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const { file } = candidate;
    try {
      const result =
        candidate.format === "v3"
          ? await migrateSessionFile(file, { dryRun })
          : await migratePi084SessionFile(file, { dryRun });
      if (result.status === "migrated") {
        migrated++;
        console.log(`${dryRun ? "would migrate" : "migrated"}  ${file}`);
      }
    } catch (error) {
      failed++;
      const cause = error instanceof Error && error.cause ? ` (${String(error.cause)})` : "";
      console.error(
        `FAILED     ${file}: ${error instanceof Error ? error.message : error}${cause}`,
      );
    }
  }
  console.log(
    dryRun
      ? `Dry run: ${migrated} file(s) would be migrated, ${failed} failed to read.`
      : `Migrated ${migrated} file(s), ${failed} failure(s). Originals kept as *.v3.bak or *.pi-084.bak.`,
  );
  return failed === 0 ? 0 : 1;
}
