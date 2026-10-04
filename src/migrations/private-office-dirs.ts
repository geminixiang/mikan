import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Migration, MigrationContext } from "./types.js";

const PRIVATE_DIR_MODE = 0o700;

function makePrivate(dir: string, context: MigrationContext): void {
  if ((lstatSync(dir).mode & 0o777) !== PRIVATE_DIR_MODE) {
    context.report(`  chmod 700 ${dir}`);
    if (!context.dryRun) chmodSync(dir, PRIVATE_DIR_MODE);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makePrivate(join(dir, entry.name), context);
  }
}

export const privateOfficeDirsMigration: Migration = Object.freeze({
  id: "0011-private-office-dirs",
  summary: "make every directory of office state readable only by its owner",
  async run(context: MigrationContext): Promise<void> {
    const root = join(context.stateDir, "conversations");
    if (existsSync(root)) makePrivate(root, context);
  },
});
