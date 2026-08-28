import { dirname } from "node:path";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { ensureDirExists } from "../utils/file-guards.js";
import { resolveConversationSettings } from "../config.js";
import type { Office } from "../office/index.js";
import * as log from "../log.js";
import type {
  ImageWorkspaceMountMode,
  WorkspaceDoorPolicy,
  WorkspaceLayout,
  WorkspaceVisibility,
} from "../types.js";
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

  // Private visibility only changes anything for shared-support: the shared
  // MEMORY.md is the one file that leaks information between offices when
  // writable, so a private office reads it but cannot write it (modeled on
  // Claude Tag's private-channel memory). "full" mounts the whole workspace
  // as one read-write bind with no separate memory file to gate, and
  // "conversation" never sees workspace memory at all.
  //
  // The `readOnly` mount flag below is a kernel-enforced boundary only for
  // sandbox backends that actually bind-mount (container/image, gondolin).
  // Host, Cloudflare, and Firecracker executors do not consume
  // WorkspaceProjection.mounts at all (see execution-resolver.ts
  // resolveSandboxConfig) and have no equivalent enforcement point; for
  // those backends this setting is honored only as prompt guidance to the
  // agent (agent/prompt.ts memoryGuidance), not as a hard boundary.
  const globalMemoryReadOnly = shared && effective.visibility === "private";
  const mounts =
    effective.layout === "full"
      ? [{ source: workspace.root, target: "/workspace" }]
      : effective.layout === "shared-support"
        ? [
            {
              source: workspace.memoryPath,
              target: "/workspace/MEMORY.md",
              ...(globalMemoryReadOnly ? { readOnly: true as const } : {}),
            },
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
        ? {
            globalMemoryPath: workspace.memoryPath,
            globalSkillsDir: workspace.skillsDir,
            ...(globalMemoryReadOnly ? { globalMemoryReadOnly: true } : {}),
          }
        : {}),
    },
  };
}

function resolveEffectiveWorkspace(
  office: Office,
): Pick<WorkspaceProjection, "doorPolicy" | "layout" | "visibility"> {
  try {
    const settings = resolveConversationSettings(office).sandbox;
    if (settings?.workspace) {
      return normalizeWorkspace(
        settings.workspace.doorPolicy,
        settings.workspace.layout,
        settings.workspace.visibility,
      );
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
  visibility: WorkspaceVisibility | undefined,
): Pick<WorkspaceProjection, "doorPolicy" | "layout" | "visibility"> {
  const policy = doorPolicy ?? "isolated";
  if (policy === "isolated") {
    return { doorPolicy: policy, layout: "conversation", visibility: "public" };
  }
  return {
    doorPolicy: policy,
    layout: layout === "full" ? "full" : "shared-support",
    // Missing visibility defaults to "public": every office that predates this
    // setting keeps today's read-write shared MEMORY.md behavior unchanged.
    visibility: visibility ?? "public",
  };
}

function legacyWorkspace(
  mode: ImageWorkspaceMountMode | undefined,
): Pick<WorkspaceProjection, "doorPolicy" | "layout" | "visibility"> {
  return mode === "full"
    ? { doorPolicy: "trusted", layout: "full", visibility: "public" }
    : mode === "private"
      ? { doorPolicy: "trusted", layout: "shared-support", visibility: "public" }
      : { doorPolicy: "isolated", layout: "conversation", visibility: "public" };
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
