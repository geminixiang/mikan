import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listRegisteredOffices, officeDir } from "../office/index.js";
import type { Migration, MigrationContext } from "./types.js";

const LEGACY_FILENAMES = ["last_prompt.jsonl", "auto-reply.disabled"] as const;

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export const legacyOfficeFilesMigration: Migration = Object.freeze({
  id: "0012-legacy-office-files",
  summary: "remove the debug prompt and auto-reply.disabled files 0.5.3 left in office directories",
  async run(context: MigrationContext): Promise<void> {
    for (const office of listRegisteredOffices(context.stateDir)) {
      for (const filename of LEGACY_FILENAMES) {
        const path = join(officeDir(context.workspaceRoot, office), filename);
        if (!isRegularFile(path)) continue;
        context.report(`  remove ${path}`);
        if (!context.dryRun) rmSync(path);
      }
    }
  },
});
