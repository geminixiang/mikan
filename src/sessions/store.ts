import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SessionStore, sessionStorageDir } from "./session-store.js";
import { atomicWritePrivateFile, readTextFileIfExists } from "../file-guards.js";
import { assertSessionSuffix, threadSuffixOf } from "./session-key.js";
import type { SessionHeader } from "./types.js";

export function isPlatformHistorySession(sessionFile: string): boolean {
  return SessionStore.readHeader(sessionFile)?.source?.kind === "platform-history";
}

export function resolveManagedSessionFile(sessionDir: string, cwd: string): string {
  const existingPath = getCurrentSessionPath(sessionDir);
  if (existingPath && !isPlatformHistorySession(existingPath)) return existingPath;
  return createManagedSessionFile(sessionDir, cwd);
}

export function extractSessionUuid(sessionFile: string): string {
  return basename(sessionFile).replace(".jsonl", "").split("_").pop()!;
}

export function extractSessionSuffix(sessionKey: string): string {
  return assertSessionSuffix(threadSuffixOf(sessionKey) ?? sessionKey);
}

function resolveChildPath(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const relation = relative(resolvedRoot, resolvedChild);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`Session path escapes its owning directory: ${JSON.stringify(child)}`);
  }
  return resolvedChild;
}

export function createManagedSessionFile(sessionDir: string, cwd: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = randomUUID();
  const sessionFile = join(sessionDir, createSessionFilename(sessionId));
  writeSessionHeader(sessionFile, cwd, sessionId);
  setCurrentPointer(sessionDir, sessionFile);
  return sessionFile;
}

function createSessionFilename(sessionId: string = randomUUID()): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${sessionId.slice(0, 8)}.jsonl`;
}

export function archiveManagedSessionFile(sessionFile: string): string | null {
  if (!existsSync(sessionFile)) return null;
  let archiveName: string;
  try {
    const sessionId = SessionStore.readHeader(sessionFile)?.id;
    if (!sessionId) throw new Error("missing header");
    archiveName = `scoped-archive-${createSessionFilename(sessionId)}`;
  } catch {
    archiveName = `scoped-archive-${createSessionFilename()}.corrupt`;
  }
  const archive = join(dirname(sessionFile), archiveName);
  const storage = sessionStorageDir(sessionFile);
  if (existsSync(storage)) renameSync(storage, sessionStorageDir(archive));
  renameSync(sessionFile, archive);
  return archive;
}

function setCurrentPointer(sessionDir: string, sessionFilePath: string): void {
  const filename = sessionFilePath.split("/").pop()!;
  mkdirSync(sessionDir, { recursive: true });
  atomicWritePrivateFile(join(sessionDir, "current"), filename);
}

export function createManagedSessionFileAtPath(
  sessionFile: string,
  cwd: string,
  parentSessionId?: string,
): string {
  writeSessionHeader(sessionFile, cwd, undefined, parentSessionId);
  return sessionFile;
}

function writeSessionHeader(
  sessionFile: string,
  cwd: string,
  sessionId = randomUUID(),
  parentSessionId?: string,
): void {
  SessionStore.writeHeaderFile(sessionFile, cwd, { id: sessionId, parentSessionId });
}

export function getThreadSessionFile(sessionsDir: string, sessionKey: string): string {
  return resolveChildPath(sessionsDir, `${extractSessionSuffix(sessionKey)}.jsonl`);
}

function isRegularSessionFile(sessionFile: string): boolean {
  try {
    return lstatSync(sessionFile).isFile();
  } catch {
    return false;
  }
}

function hasSessionHeader(sessionFile: string): boolean {
  return SessionStore.readHeader(sessionFile) !== null;
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

export function tryResolveCurrentSession(sessionDir: string): string | null {
  const fullPath = getCurrentSessionPath(sessionDir);
  if (fullPath && isRegularSessionFile(fullPath) && hasSessionHeader(fullPath)) return fullPath;
  return null;
}

export function tryResolveThreadSession(sessionFile: string): string | null {
  return isRegularSessionFile(sessionFile) && hasSessionHeader(sessionFile) ? sessionFile : null;
}

const MAIN_SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f]{8}\.jsonl$/i;

export function resolveParentSessionForThread(
  sessionsDir: string,
  threadTs: string | undefined,
): string | undefined {
  if (threadTs !== undefined) {
    const threadTimeMs = Number(threadTs) * 1000;
    if (Number.isFinite(threadTimeMs)) {
      const best = findMainSessionActiveAtTime(sessionsDir, threadTimeMs);
      if (best) return best;
    }
  }
  const path = tryResolveCurrentSession(sessionsDir);
  return path ? SessionStore.readHeader(path)?.id : undefined;
}

function mainSessionHeaders(sessionDir: string): SessionHeader[] {
  return readdirSync(sessionDir)
    .filter((name) => MAIN_SESSION_FILENAME.test(name))
    .flatMap((name) => SessionStore.readHeader(join(sessionDir, name)) ?? []);
}

function findMainSessionActiveAtTime(sessionsDir: string, targetMs: number): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;
  const started = mainSessionHeaders(sessionsDir).filter((header) => header.createdAt <= targetMs);
  if (started.length === 0) return undefined;
  return started.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id;
}
