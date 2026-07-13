import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import { basename, dirname, join } from "path";
import { SessionStore } from "../harness/index.js";
import { isRecord, parseJsonValue, readTextFileIfExists } from "../utils/file-guards.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";
import { isPlatformHistorySession } from "./metadata.js";
import { threadSuffixOf } from "./session-key.js";
export type { ResolvedSessionScope, ThreadRootMessage } from "./types.js";

/**
 * Returns the shared session directory for a conversation.
 * Channel sessions use a current pointer within this directory.
 * Thread sessions are stored as fixed files within the same directory.
 */
export function getChannelSessionDir(channelDir: string): string {
  return join(channelDir, "sessions");
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
  return threadSuffixOf(sessionKey) ?? sessionKey;
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
export function createManagedSessionFileAtPath(sessionFile: string, cwd: string): string {
  writeSessionHeader(sessionFile, cwd);
  return sessionFile;
}

function writeSessionHeader(sessionFile: string, cwd: string, sessionId = randomUUID()): void {
  const sessionDir = dirname(sessionFile);
  mkdirSync(sessionDir, { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
  atomicWritePrivateFile(sessionFile, `${JSON.stringify(header)}\n`);
}

/**
 * Returns the fixed session file path for a Slack thread.
 */
export function getThreadSessionFile(channelDir: string, sessionKey: string): string {
  return join(getChannelSessionDir(channelDir), `${extractSessionSuffix(sessionKey)}.jsonl`);
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

    return entries.length === 1 && entries[0]?.type === "session";
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
  return join(sessionDir, filename);
}

/**
 * Try to resolve an existing current session file.
 * Returns null if no current pointer exists or the pointed file has no valid session header.
 */
export function tryResolveCurrentSession(sessionDir: string): string | null {
  const fullPath = getCurrentSessionPath(sessionDir);
  if (fullPath && existsSync(fullPath) && hasSessionHeader(fullPath)) return fullPath;
  return null;
}

/**
 * Try to resolve an existing thread session file.
 * Returns the file path if found, or null if no valid thread session exists yet.
 */
export function tryResolveThreadSession(sessionFile: string): string | null {
  return existsSync(sessionFile) && hasSessionHeader(sessionFile) ? sessionFile : null;
}

/**
 * Resolve the channel's current session file path.
 * Returns null if no channel session exists.
 */
export function resolveChannelSessionFile(channelDir: string): string | null {
  return tryResolveCurrentSession(getChannelSessionDir(channelDir));
}
