/**
 * `mikan sessions` — session-file maintenance from the CLI.
 *
 *   mikan sessions migrate [--state-dir <dir>] [--workspace <dir>] [--dry-run]
 *
 * `migrate` rewrites legacy v3 session files under the workspace to pi's v4
 * JSONL format. Run it with the daemon stopped: this mikan version cannot
 * read v3 files, and old versions cannot read v4, so the deploy order is
 * stop → migrate → start. Each migrated file is verified against the v3
 * semantics before it replaces the original, and the original is kept as
 * `<file>.v3.bak`.
 */
import { join, resolve } from "node:path";
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
  const files = findV3SessionFiles(workspaceRoot);
  if (files.length === 0) {
    console.log(`No v3 session files found under ${workspaceRoot}`);
    return 0;
  }

  console.log(`Found ${files.length} v3 session file(s) under ${workspaceRoot}`);
  let migrated = 0;
  let failed = 0;
  for (const file of files) {
    try {
      const result = await migrateSessionFile(file, { dryRun });
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
      : `Migrated ${migrated} file(s), ${failed} failure(s). Originals kept as *.v3.bak.`,
  );
  return failed === 0 ? 0 : 1;
}
