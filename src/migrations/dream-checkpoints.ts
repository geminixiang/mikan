import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Migration, MigrationContext } from "./types.js";

const DREAM_CHECKPOINT_FILENAME = "dream.json";

export const dreamCheckpointsMigration: Migration = Object.freeze({
  id: "0010-dream-checkpoints",
  summary: "delete the checkpoints of the removed Dream maintenance (ADR 0012)",
  async run(context: MigrationContext): Promise<void> {
    const root = join(context.stateDir, "conversations");
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const checkpoint = join(root, entry.name, DREAM_CHECKPOINT_FILENAME);
      if (!existsSync(checkpoint)) continue;
      context.report(`  delete ${checkpoint}`);
      if (!context.dryRun) rmSync(checkpoint);
    }
  },
});
