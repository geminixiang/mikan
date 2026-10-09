import { existsSync } from "node:fs";
import { OfficeRegistry, createOfficeAddress, createWorkspace } from "../office/index.js";
import { backfillImportedUsage } from "../sessions/session-store.js";
import type { Migration, MigrationContext } from "./types.js";

export const sessionUsageMigration: Migration = Object.freeze({
  id: "0013-session-usage",
  summary: "record the spend of imported sessions in pi-durable's usage ledger",
  async run(context: MigrationContext): Promise<void> {
    const workspace = createWorkspace({
      root: context.workspaceRoot,
      stateDir: context.stateDir,
    });
    for (const record of new OfficeRegistry(context.stateDir).getOffices()) {
      const office = workspace.office(createOfficeAddress(record.platform, record.conversationId));
      if (!existsSync(office.sessionsPath)) continue;
      const sessions = await backfillImportedUsage(office.sessionsPath, context.dryRun);
      if (sessions > 0) context.report(`  ${sessions} sessions -> ${office.sessionsPath}`);
    }
  },
});
