import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { officeEventsDir, parseEventPayload } from "../events/index.js";
import { atomicWritePrivateFile } from "../file-guards.js";
import { assertPlatformName, createOfficeAddress, createWorkspace } from "../office/index.js";
import type { OfficeAddress } from "../types.js";
import type { Migration, MigrationContext } from "./types.js";

function eventAddress(source: string, filename: string): OfficeAddress {
  const payload = parseEventPayload(readFileSync(source, "utf-8"), filename);
  if (!payload.platform) {
    throw new Error(`Event has no platform, so its conversation is unknown: ${source}`);
  }
  return createOfficeAddress(assertPlatformName(payload.platform), payload.conversationId);
}

export const workspaceEventsMigration: Migration = Object.freeze({
  id: "0005-workspace-events",
  summary: "move scheduled events from <workspace>/events into each office's host state",
  async run(context: MigrationContext): Promise<void> {
    const legacyDir = join(context.workspaceRoot, "events");
    if (!existsSync(legacyDir)) return;
    const workspace = createWorkspace({ root: context.workspaceRoot, stateDir: context.stateDir });
    const filenames = readdirSync(legacyDir)
      .filter((name) => name.endsWith(".json") && lstatSync(join(legacyDir, name)).isFile())
      .toSorted();
    for (const filename of filenames) {
      const source = join(legacyDir, filename);
      const office = workspace.office(eventAddress(source, filename));
      const targetDir = officeEventsDir(office);
      const target = join(targetDir, filename);
      if (existsSync(target)) throw new Error(`Event already exists in its office: ${target}`);
      context.report(`  event ${filename} -> ${office.key}`);
      if (context.dryRun) continue;
      office.ensure();
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      atomicWritePrivateFile(target, readFileSync(source, "utf-8"));
      rmSync(source);
    }
    if (!context.dryRun && readdirSync(legacyDir).length === 0) rmdirSync(legacyDir);
  },
});
