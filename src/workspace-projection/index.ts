import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWritePrivateFile, ensureDirExists } from "../utils/file-guards.js";
import { resolveConversationSettings } from "../config.js";
import type { Office } from "../office/index.js";
import * as log from "../log.js";
import type {
  ImageWorkspaceMountMode,
  WorkspaceDoorPolicy,
  WorkspaceLayout,
  WorkspaceVisibility,
} from "../types.js";
import type { PlatformChannelKind, WorkspaceProjection } from "./types.js";

export type { PlatformChannelKind, WorkspaceProjection } from "./types.js";

const CHANNEL_KIND_FILE = "channel-kind";
const CHANNEL_KINDS: readonly PlatformChannelKind[] = [
  "public_channel",
  "private_channel",
  "im",
  "external",
];

/**
 * Record the platform's own channel kind for this conversation, as observed
 * by the adapter at message intake. Stored under the host-only office state
 * dir (never the sandbox-mounted workspace), so sandboxed code cannot
 * promote its own conversation into the shared pool. Written only on change;
 * the value is a snapshot as of the last message, which is exactly the
 * freshness the projection needs — a conversation that never speaks again
 * never needs a fresher value.
 */
export function recordPlatformChannelKind(office: Office, kind: PlatformChannelKind): void {
  if (readPlatformChannelKind(office) === kind) return;
  ensureDirExists(office.stateDir);
  atomicWritePrivateFile(join(office.stateDir, CHANNEL_KIND_FILE), kind + "\n");
}

/** The recorded platform channel kind, or undefined when never observed. */
export function readPlatformChannelKind(office: Office): PlatformChannelKind | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(office.stateDir, CHANNEL_KIND_FILE), "utf-8");
  } catch {
    return undefined;
  }
  const value = raw.trim();
  return (CHANNEL_KINDS as readonly string[]).includes(value)
    ? (value as PlatformChannelKind)
    : undefined;
}

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
  // sandbox backends that actually bind-mount (container/image). Host and
  // Cloudflare executors do not consume WorkspaceProjection.mounts at all
  // (see execution-resolver.ts resolveSandboxConfig) and have no equivalent
  // enforcement point; for those backends this setting is honored only as
  // prompt guidance to the agent (agent/prompt.ts memoryGuidance), not as a
  // hard boundary.
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
    if (settings?.image?.workspaceMount) {
      return legacyWorkspace(settings.image.workspaceMount);
    }
    return platformDerivedWorkspace(office);
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

/**
 * No explicit workspace setting anywhere: follow the platform's own channel
 * vocabulary (modeled on Claude Tag). A public channel's knowledge is shared
 * workspace-wide read-write; a private channel reads the shared pool but
 * writes only its own conversation memory; DMs, externally shared channels,
 * and conversations whose kind was never observed stay fully isolated —
 * platform-public is a necessary condition for sharing, never assumed.
 * An admin's explicit setting (conversation or global) always wins over this.
 */
function platformDerivedWorkspace(
  office: Office,
): Pick<WorkspaceProjection, "doorPolicy" | "layout" | "visibility"> {
  switch (readPlatformChannelKind(office)) {
    case "public_channel":
      return { doorPolicy: "trusted", layout: "shared-support", visibility: "public" };
    case "private_channel":
      return { doorPolicy: "trusted", layout: "shared-support", visibility: "private" };
    default:
      return { doorPolicy: "isolated", layout: "conversation", visibility: "public" };
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
