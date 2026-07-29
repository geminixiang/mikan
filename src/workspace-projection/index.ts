import { dirname } from "node:path";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { ensureDirExists } from "../utils/file-guards.js";
import { resolveConversationSettings } from "../config.js";
import type { Office } from "../office/index.js";
import * as log from "../log.js";
import type { ImageWorkspaceMountMode, WorkspaceDoorPolicy, WorkspaceLayout } from "../types.js";
import type { WorkspaceProjection } from "./types.js";

export type { WorkspaceProjection } from "./types.js";

/**
 * The single policy seam for a managed office. It both materializes the
 * host-side roots and authorizes the prompt sources that describe them.
 * Legacy image settings are deliberately translated here, never at callers.
 */
export function resolveWorkspaceProjection(office: Office): WorkspaceProjection {
  const { workspace } = office;
  const effective = resolveEffectiveWorkspace(office);

  assertDirectory(workspace.root, "Host workspace root");
  office.ensure();
  const shared = effective.layout === "shared-support";
  if (shared) {
    ensureRegularFile(workspace.memoryPath, "Workspace memory");
    ensureDirectoryRoot(workspace.skillsDir, "Workspace skills");
    ensureDirectoryRoot(workspace.eventsDir, "Workspace events");
  }

  const mounts =
    effective.layout === "full"
      ? [{ source: workspace.root, target: "/workspace" }]
      : effective.layout === "shared-support"
        ? [
            { source: workspace.memoryPath, target: "/workspace/MEMORY.md" },
            { source: workspace.skillsDir, target: "/workspace/skills" },
            { source: workspace.eventsDir, target: "/workspace/events" },
            { source: office.dir, target: `/workspace/${office.key}` },
          ]
        : [{ source: office.dir, target: `/workspace/${office.key}` }];

  return {
    ...effective,
    mounts,
    promptSources: {
      conversationDir: office.dir,
      conversationMemoryPath: office.memoryPath,
      conversationSkillsDir: office.skillsDir,
      ...(effective.layout === "shared-support" || effective.layout === "full"
        ? { globalMemoryPath: workspace.memoryPath, globalSkillsDir: workspace.skillsDir }
        : {}),
    },
  };
}

function resolveEffectiveWorkspace(
  office: Office,
): Pick<WorkspaceProjection, "doorPolicy" | "layout"> {
  try {
    const settings = resolveConversationSettings(office).sandbox;
    if (settings?.workspace) {
      return normalizeWorkspace(settings.workspace.doorPolicy, settings.workspace.layout);
    }
    return legacyWorkspace(settings?.image?.workspaceMount);
  } catch (err) {
    // Settings are host-authoritative. A malformed file must not fall back to
    // an unvalidated value from a mounted legacy location.
    log.logWarning(
      "Refusing to resolve workspace projection from malformed settings",
      err instanceof Error ? err.message : String(err),
    );
    throw new Error("Cannot resolve workspace projection: settings are malformed", { cause: err });
  }
}

function normalizeWorkspace(
  doorPolicy: WorkspaceDoorPolicy | undefined,
  layout: WorkspaceLayout | undefined,
): Pick<WorkspaceProjection, "doorPolicy" | "layout"> {
  const policy = doorPolicy ?? "isolated";
  if (policy === "isolated") return { doorPolicy: policy, layout: "conversation" };
  return { doorPolicy: policy, layout: layout === "full" ? "full" : "shared-support" };
}

function legacyWorkspace(
  mode: ImageWorkspaceMountMode | undefined,
): Pick<WorkspaceProjection, "doorPolicy" | "layout"> {
  return mode === "full"
    ? { doorPolicy: "trusted", layout: "full" }
    : mode === "private"
      ? { doorPolicy: "trusted", layout: "shared-support" }
      : { doorPolicy: "isolated", layout: "conversation" };
}

function ensureDirectoryRoot(path: string, label: string): void {
  if (!exists(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  assertDirectory(path, label);
}

function ensureRegularFile(path: string, label: string): void {
  if (!exists(path)) {
    ensureDirExists(dirname(path));
    writeFileSync(path, "", { mode: 0o600, flag: "wx" });
    return;
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch (err) {
    throw new Error(`${label} cannot be inspected: ${path}`, { cause: err });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

function assertDirectory(path: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (err) {
    throw new Error(`${label} cannot be inspected: ${path}`, { cause: err });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a regular non-symlink directory: ${path}`);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
