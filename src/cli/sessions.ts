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
import { resolveStateDir, scanArgs } from "./arg-grammar.js";

const USAGE = `Usage:
  mikan sessions migrate [--state-dir <dir>] [--workspace <dir>] [--dry-run]`;

interface Candidate {
  file: string;
  format: "v3" | "pi-084";
}

export async function runSessionsCommand(argv: string[]): Promise<number> {
  const scan = scanArgs(argv, {
    values: ["--workspace", "--state-dir"], // --state-dir is read by resolveStateDir
    flags: [["--dry-run"]],
  });
  if (scan.unknown) {
    console.error(`Unknown flag: ${scan.unknown}\n${USAGE}`);
    return 1;
  }
  if (scan.positionals[0] !== "migrate" || scan.positionals.length !== 1) {
    console.error(USAGE);
    return 1;
  }

  const workspaceArg = scan.values.get("--workspace");
  const workspaceRoot = workspaceArg
    ? resolve(workspaceArg)
    : join(resolveStateDir(argv), "workspace");
  const candidates = findCandidates(workspaceRoot);
  if (candidates.length === 0) {
    console.log(`No legacy session files found under ${workspaceRoot}`);
    return 0;
  }

  console.log(`Found ${candidates.length} legacy session file(s) under ${workspaceRoot}`);
  const dryRun = scan.flags.has("--dry-run");
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

/** Migrate one session file. Read/convert failures are reported, never thrown. */
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
