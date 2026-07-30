import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OfficeAddress } from "../types.js";
import type { Office, Workspace } from "./types.js";
import { officeKey, validateOfficeAddress } from "./address.js";
import { OfficeRegistry } from "./registry.js";

export type { Office, Workspace } from "./types.js";

/**
 * Workspace-root entries that are shared infrastructure, never office dirs.
 * The single definition behind boot-time directory setup, the events
 * watcher, the workspace projection, and the migration's legacy-dir scan.
 */
export const RESERVED_WORKSPACE_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["skills", "events", "agents", "MEMORY.md"]),
);

/**
 * Construct the Workspace value for a deployment. One construction site per
 * process (main.ts for the daemon; CLI subcommands and tests build their
 * own). The value owns the registry instance and the recorded-office cache
 * that office materialization uses on hot paths, so there is no process-wide
 * registry state.
 */
/**
 * An office's session files live in `<office dir>/sessions` — the one home of
 * that rule. String-based for surfaces that hold a conversation dir rather
 * than an `Office` value (mirrors `officeStateDir`); `Office.sessionsDir` is
 * derived from it. Pointer/thread-file semantics live in `sessions/store`.
 */
export function officeSessionsDir(officeDir: string): string {
  return join(officeDir, "sessions");
}

export function createWorkspace(options: { root: string; stateDir: string }): Workspace {
  // Paths are joined as given (no resolve) so values match what callers
  // passing the same root/stateDir strings computed before this module.
  const { root, stateDir } = options;
  // Lazy: CLI surfaces construct a Workspace for path math without paying
  // for (or being allowed to create) the registry journal.
  let registry: OfficeRegistry | undefined;
  const recorded = new Set<string>();
  const offices = new Map<string, Office>();

  const workspace: Workspace = Object.freeze({
    root,
    stateDir,
    memoryPath: join(root, "MEMORY.md"),
    skillsDir: join(root, "skills"),
    eventsDir: join(root, "events"),
    agentsDir: join(root, "agents"),
    reservedNames: RESERVED_WORKSPACE_NAMES,
    office(address: OfficeAddress): Office {
      const normalized = validateOfficeAddress(address);
      const key = officeKey(normalized);
      const existing = offices.get(key);
      if (existing) return existing;

      const dir = join(root, key);
      const office: Office = Object.freeze({
        address: normalized,
        key,
        dir,
        memoryPath: join(dir, "MEMORY.md"),
        skillsDir: join(dir, "skills"),
        sessionsDir: officeSessionsDir(dir),
        attachmentsDir: join(dir, "attachments"),
        logPath: join(dir, "log.jsonl"),
        stateDir: join(stateDir, "conversations", key),
        workspace,
        ensure(): string {
          // Record-first ordering: a crash can leave a record without a
          // directory (harmless; recreated on the next message) but never an
          // anonymous office directory the registry cannot enumerate.
          if (!recorded.has(key)) {
            registry ??= new OfficeRegistry(stateDir);
            registry.recordOffice(normalized);
            recorded.add(key);
          }
          ensureRegularOfficeDirectory(dir);
          return dir;
        },
      });
      offices.set(key, office);
      return office;
    },
  });
  return workspace;
}

/** mkdir-if-missing with the same fail-closed type guard as projection roots. */
function ensureRegularOfficeDirectory(dir: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Office directory must be a regular non-symlink directory: ${dir}`);
  }
}
