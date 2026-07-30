import { randomUUID } from "crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { SessionStore } from "../harness/index.js";
import {
  atomicWritePrivateFile,
  isRecord,
  parseJsonValue,
  readTextFileIfExists,
} from "../utils/file-guards.js";
import { officeSessionsDir } from "../office/index.js";
import { assertSessionSuffix, threadSuffixOf } from "./session-key.js";
export type { ResolvedSessionScope, ThreadRootMessage } from "./types.js";
export type { MikanSessionHeader } from "./types.js";
import type { MikanSessionHeader } from "./types.js";

export function isPlatformHistorySession(sessionFile: string): boolean {
  try {
    const header = SessionStore.open(sessionFile).getHeader() as MikanSessionHeader | null;
    return header?.source?.kind === "platform-history";
  } catch {
    return false;
  }
}

/**
 * Resolves the current active session file for a session directory.
 * Reads the "current" pointer file; creates a new session if none exists
 * or the pointed-to file is missing.
 */
export function resolveSessionFile(sessionDir: string): string {
  const existing = tryResolveCurrentSession(sessionDir);
  if (existing) return existing;
  return createNewSessionFile(sessionDir);
}

/**
 * Resolve the current active session file for a session directory.
 * Creates a fully initialized persistent session with the provided cwd when none exists.
 */
export function resolveManagedSessionFile(sessionDir: string, cwd: string): string {
  const existingPath = getCurrentSessionPath(sessionDir);
  if (existingPath && !isPlatformHistorySession(existingPath)) return existingPath;
  return createManagedSessionFile(sessionDir, cwd);
}

/**
 * Extracts the short UUID from a session file path.
 * e.g. "2026-04-05T00-00_7b54cf90.jsonl" → "7b54cf90"
 */
export function extractSessionUuid(sessionFile: string): string {
  return basename(sessionFile).replace(".jsonl", "").split("_").pop()!;
}

/**
 * Extracts the thread/suffix part of a session key.
 * "channelId:threadId" → "threadId", "channelId" → "channelId"
 */
export function extractSessionSuffix(sessionKey: string): string {
  return assertSessionSuffix(threadSuffixOf(sessionKey) ?? sessionKey);
}

/**
 * Resolve one child path and prove it remains inside its owning directory.
 * Identity validation is the first guard; containment is defense in depth for
 * every session path derived from platform-controlled values.
 */
function resolveChildPath(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const relation = relative(resolvedRoot, resolvedChild);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`Session path escapes its owning directory: ${JSON.stringify(child)}`);
  }
  return resolvedChild;
}

/**
 * Creates an empty timestamped file and updates the "current" pointer.
 * Used only by tests for placeholder-file scenarios.
 *
 * Order matters: write the session file first, then atomic-rename the pointer
 * last so a crash mid-create never leaves "current" pointing at a missing file.
 */
export function createNewSessionFile(sessionDir: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const filename = createSessionFilename();
  const filePath = join(sessionDir, filename);
  atomicWritePrivateFile(filePath, "");
  atomicWritePrivateFile(join(sessionDir, "current"), filename);
  return filePath;
}

/**
 * Creates a new persistent session file with a proper SessionManager header and cwd.
 * Also updates the "current" pointer. Header is written before the pointer flips so a
 * partial create cannot leave "current" pointing at a missing file.
 */
export function createManagedSessionFile(sessionDir: string, cwd: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = randomUUID();
  const sessionFile = join(sessionDir, createSessionFilename(sessionId));
  writeSessionHeader(sessionFile, cwd, sessionId);
  setCurrentPointer(sessionDir, sessionFile);
  return sessionFile;
}

/**
 * Open a session file with an explicit cwd, even if the file does not exist yet.
 * This avoids SessionStore.open() falling back to process.cwd() for fresh sessions.
 */
export function openManagedSession(sessionFile: string, cwd: string): SessionStore {
  if (shouldRecreatePreinitializedSession(sessionFile)) {
    rmSync(sessionFile, { force: true });
  }

  return SessionStore.open(sessionFile, cwd);
}

function createSessionFilename(sessionId = randomUUID()): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${sessionId.slice(0, 8)}.jsonl`;
}

function setCurrentPointer(sessionDir: string, sessionFilePath: string): void {
  const filename = sessionFilePath.split("/").pop()!;
  mkdirSync(sessionDir, { recursive: true });
  atomicWritePrivateFile(join(sessionDir, "current"), filename);
}

/**
 * Creates or overwrites a fixed-path session file with a valid session header.
 */
export interface ParentSessionRef {
  path: string;
  id: string;
}

export function createManagedSessionFileAtPath(
  sessionFile: string,
  cwd: string,
  parent?: ParentSessionRef,
): string {
  writeSessionHeader(sessionFile, cwd, undefined, parent);
  return sessionFile;
}

function writeSessionHeader(
  sessionFile: string,
  cwd: string,
  sessionId = randomUUID(),
  parent?: ParentSessionRef,
): void {
  mkdirSync(dirname(sessionFile), { recursive: true });
  // The header format (and its version) is owned by the harness store; this
  // layer only decides the path and the id.
  SessionStore.create(sessionFile, cwd, {
    id: sessionId,
    ...(parent ? { parentSession: parent.path, parentSessionId: parent.id } : {}),
  });
}

/**
 * Returns the fixed session file path for a Slack thread.
 */
export function getThreadSessionFile(channelDir: string, sessionKey: string): string {
  const sessionDir = officeSessionsDir(channelDir);
  return resolveChildPath(sessionDir, `${extractSessionSuffix(sessionKey)}.jsonl`);
}

function isRegularSessionFile(sessionFile: string): boolean {
  try {
    return lstatSync(sessionFile).isFile();
  } catch {
    return false;
  }
}

function hasSessionHeader(sessionFile: string): boolean {
  try {
    const raw = readTextFileIfExists(sessionFile);
    if (raw === undefined) return false;
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseSessionEntry(trimmed);
      return entry.type === "session";
    }
  } catch {
    return false;
  }
  return false;
}

function shouldRecreatePreinitializedSession(sessionFile: string): boolean {
  try {
    const raw = readTextFileIfExists(sessionFile);
    if (raw === undefined) return false;
    const entries = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseSessionEntry);

    if (entries.length !== 1 || entries[0]?.type !== "session") return false;
    // Sessions with lineage metadata are fully initialized — preserve them.
    const h = entries[0] as { parentSession?: unknown; parentSessionId?: unknown };
    if (h.parentSession || h.parentSessionId) return false;
    return true;
  } catch {
    return false;
  }
}

function parseSessionEntry(line: string): { type?: string } {
  return parseJsonValue(
    line,
    (value): value is { type?: string } => isRecord(value),
    (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
  );
}

function getCurrentSessionPath(sessionDir: string): string | null {
  const pointerFile = join(sessionDir, "current");
  const filename = readTextFileIfExists(pointerFile)?.trim();
  if (!filename) return null;
  try {
    return resolveChildPath(sessionDir, filename);
  } catch {
    return null;
  }
}

/**
 * Try to resolve an existing current session file.
 * Returns null if no current pointer exists or the pointed file has no valid session header.
 */
export function tryResolveCurrentSession(sessionDir: string): string | null {
  const fullPath = getCurrentSessionPath(sessionDir);
  if (fullPath && isRegularSessionFile(fullPath) && hasSessionHeader(fullPath)) return fullPath;
  return null;
}

/**
 * Try to resolve an existing thread session file.
 * Returns the file path if found, or null if no valid thread session exists yet.
 */
export function tryResolveThreadSession(sessionFile: string): string | null {
  return isRegularSessionFile(sessionFile) && hasSessionHeader(sessionFile) ? sessionFile : null;
}

/**
 * Resolve the channel's current session file path.
 * Returns null if no channel session exists.
 */
export function resolveChannelSessionFile(channelDir: string): string | null {
  return tryResolveCurrentSession(officeSessionsDir(channelDir));
}

// Matches timestamped main session filenames; thread sessions use bare threadTs.
const MAIN_SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f]{8}\.jsonl$/i;

/**
 * Resolve the main session file that was active when a thread was created.
 * Uses the thread's Slack timestamp to find the main session whose creation
 * time is the latest one at or before that moment — stable across rotations.
 * Falls back to resolveChannelSessionFile when threadTs is absent or unparseable.
 * Returns both path and session UUID so callers can store a UUID-stable reference.
 */
export function resolveParentSessionForThread(
  channelDir: string,
  threadTs: string | undefined,
): ParentSessionRef | null {
  if (threadTs !== undefined) {
    const threadTimeMs = Number(threadTs) * 1000;
    if (Number.isFinite(threadTimeMs)) {
      const best = findMainSessionActiveAtTime(channelDir, threadTimeMs);
      if (best) return best;
    }
  }
  const path = resolveChannelSessionFile(channelDir);
  if (!path) return null;
  const id = readSessionHeaderSummary(path)?.id;
  return id ? { path, id } : null;
}

function findMainSessionActiveAtTime(
  channelDir: string,
  targetMs: number,
): ParentSessionRef | null {
  const sessionDir = officeSessionsDir(channelDir);
  if (!existsSync(sessionDir)) return null;

  let best: ParentSessionRef | null = null;
  let bestCreatedMs = -Infinity;

  for (const name of readdirSync(sessionDir)) {
    if (!MAIN_SESSION_FILENAME.test(name)) continue;
    const filePath = join(sessionDir, name);
    const summary = readSessionHeaderSummary(filePath);
    if (!summary) continue;
    if (summary.timestampMs <= targetMs && summary.timestampMs > bestCreatedMs) {
      bestCreatedMs = summary.timestampMs;
      best = { path: filePath, id: summary.id };
    }
  }
  return best;
}

function readSessionHeaderSummary(filePath: string): { id: string; timestampMs: number } | null {
  try {
    const raw = readTextFileIfExists(filePath);
    if (!raw) return null;
    const firstLine = raw.slice(0, raw.indexOf("\n")).trim();
    if (!firstLine) return null;
    const entry = parseSessionEntry(firstLine);
    const { id, timestamp } = entry as { id?: unknown; timestamp?: unknown };
    if (typeof id !== "string" || typeof timestamp !== "string") return null;
    const timestampMs = new Date(timestamp).getTime();
    return Number.isFinite(timestampMs) ? { id, timestampMs } : null;
  } catch {
    return null;
  }
}
