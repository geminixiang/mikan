import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { atomicWritePrivateFile, ensureDirExists, ensurePrivateDirExists } from "../file-guards.js";
import { loadOfficeVisibilityOverride } from "../settings/index.js";
import { listRegisteredOffices } from "./index.js";
import type { Office, PlatformChannelKind, WorkspaceProjection } from "./types.js";
import * as log from "../log.js";
import { guestPublicOfficePath, guestWorkspacePath } from "../sandbox/layout.js";
import type { WorkspaceVisibility } from "../types.js";
import { errorMessage } from "../unknown-values.js";

const CHANNEL_KIND_FILE = "channel-kind";
const CHANNEL_KINDS: readonly PlatformChannelKind[] = [
  "public_channel",
  "private_channel",
  "im",
  "external",
];

export function recordPlatformChannelKind(office: Office, kind: PlatformChannelKind): void {
  if (readPlatformChannelKind(office) === kind) return;
  ensurePrivateDirExists(office.stateDir);
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
      `${path}: ${errorMessage(err)}`,
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

function readablePublicOffices(self: Office): Office[] {
  const { workspace } = self;
  return listRegisteredOffices(workspace.stateDir)
    .map((record) => workspace.office(record))
    .filter(
      (other) =>
        other.key !== self.key &&
        exists(other.dir) &&
        resolveOfficeVisibility(other).visibility === "public",
    )
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

export function resolveWorkspaceProjection(office: Office): WorkspaceProjection {
  const { workspace } = office;
  const decision = resolveOfficeVisibility(office);
  const readOnlyKnowledge = decision.visibility === "private";
  const publicOffices = readablePublicOffices(office);

  assertDirectory(workspace.root, "Host workspace root");
  office.ensure();
  ensureRegularFile(workspace.memoryPath, "Workspace memory");
  ensureDirectoryRoot(workspace.skillsDir, "Workspace skills");
  return {
    ...decision,
    mounts: [
      { source: office.dir, target: guestWorkspacePath(office.key) },
      {
        source: workspace.memoryPath,
        target: guestWorkspacePath("MEMORY.md"),
        readOnly: readOnlyKnowledge ? true : undefined,
      },
      {
        source: workspace.skillsDir,
        target: guestWorkspacePath("skills"),
        readOnly: readOnlyKnowledge ? true : undefined,
      },
      ...publicOffices.map((other) => ({
        source: other.dir,
        target: guestPublicOfficePath(other.key),
        readOnly: true,
      })),
    ],
    readableConversationIds: [
      office.address.conversationId,
      ...publicOffices.map((other) => other.address.conversationId),
    ],
    promptSources: {
      conversationMemoryPath: office.memoryPath,
      conversationSkillsDir: office.skillsDir,
      globalMemoryPath: workspace.memoryPath,
      globalSkillsDir: workspace.skillsDir,
      globalKnowledgeReadOnly: readOnlyKnowledge ? true : undefined,
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
