import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWritePrivateFile } from "../file-guards.js";
import { listRegisteredOffices, officeDir, officeStateDir } from "../office/index.js";
import type { Migration, MigrationContext } from "./types.js";

const SETTINGS_FILENAME = "settings.json";

export const conversationSettingsMigration: Migration = Object.freeze({
  id: "0003-conversation-settings",
  summary: "move conversation settings.json out of the sandbox-visible office directory",
  async run(context: MigrationContext): Promise<void> {
    for (const office of listRegisteredOffices(context.stateDir)) {
      const source = join(officeDir(context.workspaceRoot, office), SETTINGS_FILENAME);
      if (!existsSync(source)) continue;
      if (!lstatSync(source).isFile()) {
        throw new Error(`Conversation settings must be a regular file: ${source}`);
      }
      const targetDir = officeStateDir(context.stateDir, office);
      const target = join(targetDir, SETTINGS_FILENAME);
      if (existsSync(target)) {
        throw new Error(`Both ${source} and ${target} exist; merge them into ${target}`);
      }
      context.report(`  settings ${source} -> ${target}`);
      if (context.dryRun) continue;
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      atomicWritePrivateFile(target, readFileSync(source, "utf-8"));
      rmSync(source);
    }
  },
});
