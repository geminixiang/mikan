import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { listRegisteredOffices, officeDir, officeStateDir } from "../office/index.js";
import type { Migration, MigrationContext } from "./types.js";

const SESSIONS_DIRNAME = "sessions";

function moveFile(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
    unlinkSync(source);
  }
}

function dropLink(context: MigrationContext, path: string): void {
  context.report(`  skip link ${path} (removed, never followed)`);
  if (!context.dryRun) unlinkSync(path);
}

function moveSessions(context: MigrationContext, source: string, target: string): void {
  if (lstatSync(source).isSymbolicLink()) {
    dropLink(context, source);
    return;
  }
  if (!lstatSync(source).isDirectory()) {
    throw new Error(`Expected a sessions directory: ${source}`);
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`Both ${source} and ${target} exist; merge them into ${target}`);
  }
  context.report(`  sessions ${source} -> ${target}`);
  const entries = readdirSync(source, { withFileTypes: true });
  const unexpected = entries.find((entry) => !entry.isFile() && !entry.isSymbolicLink());
  if (unexpected) {
    throw new Error(`Unexpected entry in sessions directory: ${join(source, unexpected.name)}`);
  }
  if (context.dryRun) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const from = join(source, entry.name);
    if (entry.isSymbolicLink()) dropLink(context, from);
    else moveFile(from, join(target, entry.name));
  }
  rmdirSync(source);
}

export const officeSessionsMigration: Migration = Object.freeze({
  id: "0008-office-sessions",
  summary: "move session files out of the sandbox-visible office directory",
  async run(context: MigrationContext): Promise<void> {
    for (const office of listRegisteredOffices(context.stateDir)) {
      const source = join(officeDir(context.workspaceRoot, office), SESSIONS_DIRNAME);
      if (!existsSync(source) && !isLink(source)) continue;
      moveSessions(
        context,
        source,
        join(officeStateDir(context.stateDir, office), SESSIONS_DIRNAME),
      );
    }
  },
});

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
