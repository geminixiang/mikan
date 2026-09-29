import { listRegisteredOffices } from "../office/index.js";
import { legacyResourceKey } from "./office-layout.js";
import type { Migration, MigrationContext } from "./types.js";

function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function listContainerNames(context: MigrationContext): Promise<Set<string> | undefined> {
  try {
    const stdout = await context.docker(["ps", "-a", "--format", "{{.Names}}"]);
    return new Set(stdout.split("\n").map((name) => name.trim()));
  } catch (error) {
    if (isMissingExecutable(error)) return undefined;
    throw error;
  }
}

export const sandboxContainersMigration: Migration = Object.freeze({
  id: "0006-sandbox-containers",
  summary: "remove sandbox containers named by raw conversation IDs; offices recreate their own",
  async run(context: MigrationContext): Promise<void> {
    const existing = await listContainerNames(context);
    if (!existing) {
      context.report("  docker is not installed; no containers to remove");
      return;
    }
    const legacyNames = listRegisteredOffices(context.stateDir)
      .map((office) => `mikan-sandbox-${legacyResourceKey(office.conversationId)}`)
      .filter((name) => existing.has(name));
    for (const name of new Set(legacyNames)) {
      context.report(`  container ${name}`);
      if (!context.dryRun) await context.docker(["rm", "-f", name]);
    }
  },
});
