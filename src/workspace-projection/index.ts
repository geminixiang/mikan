import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { ensureDirExists } from "../utils/file-guards.js";
import { resolveConversationSettings } from "../config.js";
import * as log from "../log.js";
import type { ImageWorkspaceMountMode, WorkspaceDoorPolicy, WorkspaceLayout } from "../types.js";
import type { WorkspaceProjection } from "./types.js";

export type { WorkspaceProjection } from "./types.js";

/**
 * The single policy seam for a managed office. It both materializes the
 * host-side roots and authorizes the prompt sources that describe them.
 * Legacy image settings are deliberately translated here, never at callers.
 */
export function resolveWorkspaceProjection(
  hostWorkspaceRoot: string | undefined,
  conversationId: string,
): WorkspaceProjection {
  assertConversationPathSegment(conversationId);
  const conversationDir = hostWorkspaceRoot
    ? join(hostWorkspaceRoot, conversationId)
    : join("/workspace", conversationId);
  const effective = resolveEffectiveWorkspace(hostWorkspaceRoot, conversationId);

  if (!hostWorkspaceRoot) {
    return {
      ...effective,
      mode: effective.layout === "full" ? "full" : "private",
      mounts: [],
      promptSources: {
        conversationDir,
        conversationMemoryPath: join(conversationDir, "MEMORY.md"),
        conversationSkillsDir: join(conversationDir, "skills"),
        ...(effective.layout === "shared-support" || effective.layout === "full"
          ? {
              globalMemoryPath: "/workspace/MEMORY.md",
              globalSkillsDir: "/workspace/skills",
            }
          : {}),
      },
    };
  }

  assertDirectory(hostWorkspaceRoot, "Host workspace root");
  ensureDirectoryRoot(conversationDir, "Conversation workspace");
  const memoryPath = join(hostWorkspaceRoot, "MEMORY.md");
  const skillsPath = join(hostWorkspaceRoot, "skills");
  const eventsPath = join(hostWorkspaceRoot, "events");
  const shared = effective.layout === "shared-support";
  if (shared) {
    ensureRegularFile(memoryPath, "Workspace memory");
    ensureDirectoryRoot(skillsPath, "Workspace skills");
    ensureDirectoryRoot(eventsPath, "Workspace events");
  }

  const mounts =
    effective.layout === "full"
      ? [{ source: hostWorkspaceRoot, target: "/workspace" }]
      : effective.layout === "shared-support"
        ? [
            { source: memoryPath, target: "/workspace/MEMORY.md" },
            { source: skillsPath, target: "/workspace/skills" },
            { source: eventsPath, target: "/workspace/events" },
            { source: conversationDir, target: `/workspace/${conversationId}` },
          ]
        : [{ source: conversationDir, target: `/workspace/${conversationId}` }];

  return {
    ...effective,
    mode: effective.layout === "full" ? "full" : "private",
    mounts,
    promptSources: {
      conversationDir,
      conversationMemoryPath: join(conversationDir, "MEMORY.md"),
      conversationSkillsDir: join(conversationDir, "skills"),
      ...(effective.layout === "shared-support" || effective.layout === "full"
        ? { globalMemoryPath: memoryPath, globalSkillsDir: skillsPath }
        : {}),
    },
  };
}

/** Compatibility reader for old status callers. */
export function readWorkspaceProjectionMode(
  hostWorkspaceRoot: string | undefined,
  conversationId: string,
): ImageWorkspaceMountMode {
  return resolveWorkspaceProjection(hostWorkspaceRoot, conversationId).mode;
}

function resolveEffectiveWorkspace(
  hostWorkspaceRoot: string | undefined,
  conversationId: string,
): Pick<WorkspaceProjection, "doorPolicy" | "layout"> {
  const fallback = { doorPolicy: "isolated" as const, layout: "conversation" as const };
  if (!hostWorkspaceRoot) return fallback;

  const conversationDir = join(hostWorkspaceRoot, conversationId);
  try {
    const settings = resolveConversationSettings(conversationDir).sandbox;
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

function assertConversationPathSegment(conversationId: string): void {
  if (
    conversationId.length === 0 ||
    conversationId === "." ||
    conversationId === ".." ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw new Error("Conversation id must be a safe path segment");
  }
}
