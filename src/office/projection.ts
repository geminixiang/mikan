import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWritePrivateFile, ensureDirExists } from "../file-guards.js";
import { loadOfficeVisibilityOverride } from "../settings/index.js";
import { listRegisteredOffices, type Office } from "./index.js";
import * as log from "../log.js";
import type { ContainerMount, WorkspaceVisibility } from "../types.js";
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
  const path = join(office.stateDir, CHANNEL_KIND_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log.logWarning(
      "Could not read platform channel kind; treating the office as private",
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  const value = raw.trim();
  return (CHANNEL_KINDS as readonly string[]).includes(value)
    ? (value as PlatformChannelKind)
    : undefined;
}

/** Where an office's visibility came from; shown to operators instead of raw values. */
export interface OfficeVisibilityDecision {
  visibility: WorkspaceVisibility;
  source: "platform" | "override" | "unknown";
}

/** Platforms whose public conversations become public offices (ADR 0008). */
const PUBLIC_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["slack"]);

/**
 * One dimension, derived from the platform (ADR 0008): Slack public channels
 * are public; private channels, DMs, group DMs, and externally shared
 * conversations are private; a Slack conversation whose kind has not been
 * recorded yet fails closed to private. Every other platform is private by
 * decision, not by omission — Telegram groups, Discord channels, and GitHub
 * threads have no "visible to the whole workspace" notion that maps cleanly
 * onto a shared office. An operator may narrow a public conversation to
 * private, never the reverse.
 */
export function resolveOfficeVisibility(office: Office): OfficeVisibilityDecision {
  if (loadOfficeVisibilityOverride(office) === "private") {
    return { visibility: "private", source: "override" };
  }
  if (!PUBLIC_CAPABLE_PLATFORMS.has(office.address.platform)) {
    return { visibility: "private", source: "platform" };
  }
  const kind = readPlatformChannelKind(office);
  if (kind === undefined) return { visibility: "private", source: "unknown" };
  return { visibility: kind === "public_channel" ? "public" : "private", source: "platform" };
}

/**
 * Every public office other than `self`, as read-only mounts under
 * `/workspace/public/<key>`. Bind mounts rather than a symlink directory:
 * symlinks would resolve against the container's own filesystem, where host
 * paths do not exist. A public channel appearing or changing visibility
 * changes the mount signature, so affected containers rebuild on their next
 * message with contents preserved.
 */
function publicOfficeMounts(self: Office): ContainerMount[] {
  const { workspace } = self;
  const mounts: ContainerMount[] = [];
  for (const record of listRegisteredOffices(workspace.stateDir)) {
    const other = workspace.office(record);
    if (other.key === self.key || !exists(other.dir)) continue;
    if (resolveOfficeVisibility(other).visibility !== "public") continue;
    mounts.push({ source: other.dir, target: `/workspace/public/${other.key}`, readOnly: true });
  }
  return mounts.toSorted((a, b) => a.target.localeCompare(b.target));
}

/**
 * The single policy seam for a managed office. It both materializes the
 * host-side roots and authorizes the prompt sources that describe them.
 * Every office gets the same shape (ADR 0008): its own directory read-write,
 * every other public office read-only under /workspace/public, and the
 * workspace-global knowledge read-write for public offices or read-only for
 * private ones. No layout mounts the workspace root.
 */
export function resolveWorkspaceProjection(office: Office): WorkspaceProjection {
  const { workspace } = office;
  const decision = resolveOfficeVisibility(office);
  const readOnlyKnowledge = decision.visibility === "private";

  assertDirectory(workspace.root, "Host workspace root");
  office.ensure();
  ensureRegularFile(workspace.memoryPath, "Workspace memory");
  ensureDirectoryRoot(workspace.skillsDir, "Workspace skills");
  const ro = { readOnly: true as const };
  return {
    ...decision,
    mounts: [
      { source: office.dir, target: `/workspace/${office.key}` },
      {
        source: workspace.memoryPath,
        target: "/workspace/MEMORY.md",
        ...(readOnlyKnowledge ? ro : {}),
      },
      {
        source: workspace.skillsDir,
        target: "/workspace/skills",
        ...(readOnlyKnowledge ? ro : {}),
      },
      ...publicOfficeMounts(office),
    ],
    promptSources: {
      conversationDir: office.dir,
      conversationMemoryPath: office.memoryPath,
      conversationSkillsDir: office.skillsDir,
      globalMemoryPath: workspace.memoryPath,
      globalSkillsDir: workspace.skillsDir,
      ...(readOnlyKnowledge ? { globalKnowledgeReadOnly: true } : {}),
    },
  };
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
