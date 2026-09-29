import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWritePrivateFile } from "../file-guards.js";
import type { Migration, MigrationContext } from "./types.js";

export const modelsJsonMigration: Migration = Object.freeze({
  id: "0007-models-json",
  summary: "copy custom model providers from Pi's models.json to mikan's own",
  async run(context: MigrationContext): Promise<void> {
    const source = join(context.piAgentDir, "models.json");
    if (existsSync(context.modelsPath) || !existsSync(source)) return;
    context.report(`  models.json ${source} -> ${context.modelsPath}`);
    if (context.dryRun) return;
    mkdirSync(dirname(context.modelsPath), { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(context.modelsPath, readFileSync(source, "utf-8"));
  },
});
