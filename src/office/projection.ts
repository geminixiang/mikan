import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWritePrivateFile, ensureDirExists } from "../file-guards.js";
import { loadOfficeVisibilityOverride } from "../settings/index.js";
import { listRegisteredOffices, type Office } from "./index.js";
import * as log from "../log.js";
import { guestPublicOfficePath, guestWorkspacePath } from "../sandbox/layout.js";
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

export function recordPlatformChannelKind(office: Office, kind: PlatformChannelKind): void {
  if (readPlatformChannelKind(office) === kind) return;
  ensureDirExists(office.stateDir);
  atomicWritePrivateFile(join(office.stateDir, CHANNEL_KIND_FILE), kind + "\n");
}

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

export interface OfficeVisibilityDecision {
  visibility: WorkspaceVisibility;
  source: "platform" | "override" | "unknown";
}

const PUBLIC_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["slack"]);

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

function publicOfficeMounts(self: Office): ContainerMount[] {
  const { workspace } = self;
  const mounts: ContainerMount[] = [];
  for (const record of listRegisteredOffices(workspace.stateDir)) {
    const other = workspace.office(record);
    if (other.key === self.key || !exists(other.dir)) continue;
    if (resolveOfficeVisibility(other).visibility !== "public") continue;
    mounts.push({ source: other.dir, target: guestPublicOfficePath(other.key), readOnly: true });
  }
  return mounts.toSorted((a, b) => a.target.localeCompare(b.target));
}

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
      { source: office.dir, target: guestWorkspacePath(office.key) },
      {
        source: workspace.memoryPath,
        target: guestWorkspacePath("MEMORY.md"),
        ...(readOnlyKnowledge ? ro : {}),
      },
      {
        source: workspace.skillsDir,
        target: guestWorkspacePath("skills"),
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
