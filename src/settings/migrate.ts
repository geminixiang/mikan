/**
 * One-time settings migrations run by `mikan office …` with the daemon
 * stopped. Runtime code never imports this file.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWritePrivateFile } from "../file-guards.js";
import { listRegisteredOffices, type Workspace } from "../office/index.js";
import type { OfficeKey } from "../types.js";
import {
  compactSettingsConfig,
  hasDefinedValue,
  loadSettingsFile,
  type SandboxFileSettings,
  type SettingsFileConfig,
} from "./index.js";

export interface DoorPolicyMigrationReport {
  /** Retired keys removed from the global settings file. */
  global: string[];
  conversations: { key: OfficeKey; removed: string[]; visibility?: "private" }[];
  skipped: { key: OfficeKey | "global"; reason: string }[];
}

const RETIRED_KEYS = {
  image: "sandbox.image.workspaceMount",
  workspace: "sandbox.workspace",
} as const;

/**
 * Strip the retired door-policy keys from one settings file. Returns the
 * removed key paths, or an empty list when nothing had to change (the file is
 * then left byte-for-byte alone, which also preserves `{}` migration markers).
 * The only value carried forward is an explicit shared-support `private`
 * visibility, which maps onto `office.visibility` (ADR 0008). Every other
 * retired combination — `full`, `isolated`, legacy `private` — is dropped
 * without deriving a grant.
 */
function stripRetiredDoorPolicy(
  settingsPath: string,
  allowVisibilityCarry: boolean,
): { removed: string[]; visibility?: "private" } {
  const existing = loadSettingsFile(settingsPath);
  if (!existing?.sandbox) return { removed: [] };
  const { image, workspace, ...sandboxRest } = existing.sandbox;
  const removed: string[] = [];
  if (image?.workspaceMount !== undefined) removed.push(RETIRED_KEYS.image);
  if (workspace !== undefined) removed.push(RETIRED_KEYS.workspace);
  if (removed.length === 0) return { removed };
  const carry =
    allowVisibilityCarry &&
    workspace?.doorPolicy === "trusted" &&
    workspace.layout !== "full" &&
    workspace.visibility === "private";
  const { workspaceMount: _mount, ...imageRest } = image ?? {};
  const sandbox: SandboxFileSettings = {
    ...sandboxRest,
    ...(hasDefinedValue(imageRest) ? { image: imageRest } : {}),
  };
  const next: SettingsFileConfig = {
    ...existing,
    sandbox,
    ...(carry ? { office: { ...existing.office, visibility: "private" as const } } : {}),
  };
  atomicWritePrivateFile(settingsPath, JSON.stringify(compactSettingsConfig(next), null, 2));
  return { removed, ...(carry ? { visibility: "private" as const } : {}) };
}

/**
 * One-time removal of the retired door-policy settings from the global file
 * and every registered office (ADR 0008). Run with the daemon stopped.
 */
export function migrateLegacyDoorPolicy(workspace: Workspace): DoorPolicyMigrationReport {
  const report: DoorPolicyMigrationReport = { global: [], conversations: [], skipped: [] };
  try {
    report.global = stripRetiredDoorPolicy(
      join(workspace.stateDir, "settings.json"),
      false,
    ).removed;
  } catch (error) {
    report.skipped.push({
      key: "global",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  for (const record of listRegisteredOffices(workspace.stateDir)) {
    const office = workspace.office(record);
    const settingsPath = join(office.stateDir, "settings.json");
    if (!existsSync(settingsPath)) continue;
    try {
      const result = stripRetiredDoorPolicy(settingsPath, true);
      if (result.removed.length > 0) report.conversations.push({ key: office.key, ...result });
    } catch (error) {
      report.skipped.push({
        key: office.key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
