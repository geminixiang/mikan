import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SessionStore, sessionStorageDir } from "./session-store.js";
import { atomicWritePrivateFile, parseJsonValue, readTextFileIfExists } from "../file-guards.js";
import { assertSessionSuffix, threadSuffixOf } from "./session-key.js";
import type { MikanSessionHeader, ParentSessionRef } from "./types.js";
import { isRecord } from "../unknown-values.js";

export function isPlatformHistorySession(sessionFile: string): boolean {
  try {
    const header = SessionStore.readHeader(sessionFile);
    const source = (header?.metadata as MikanSessionHeader | undefined)?.source;
    return source?.kind === "platform-history";
  } catch {
    return false;
  }
}

export function resolveSessionFile(sessionDir: string): string {
  const existing = tryResolveCurrentSession(sessionDir);
  if (existing) return existing;
  return createNewSessionFile(sessionDir);
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

export function createNewSessionFile(sessionDir: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const filename = createSessionFilename();
  const filePath = join(sessionDir, filename);
  atomicWritePrivateFile(filePath, "");
  atomicWritePrivateFile(join(sessionDir, "current"), filename);
  return filePath;
}

export function createManagedSessionFile(sessionDir: string, cwd: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = randomUUID();
  const sessionFile = join(sessionDir, createSessionFilename(sessionId));
  writeSessionHeader(sessionFile, cwd, sessionId);
  setCurrentPointer(sessionDir, sessionFile);
  return sessionFile;
}

export function openManagedSession(sessionFile: string, cwd: string): Promise<SessionStore> {
  if (shouldRecreatePreinitializedSession(sessionFile)) {
    rmSync(sessionFile, { force: true });
  }

  return SessionStore.open(sessionFile, cwd);
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
  SessionStore.writeHeaderFile(sessionFile, cwd, {
    id: sessionId,
    parentSession: parent?.path,
    parentSessionId: parent?.id,
  });
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

function shouldRecreatePreinitializedSession(sessionFile: string): boolean {
  if (existsSync(sessionStorageDir(sessionFile))) return false;
  try {
    const raw = readTextFileIfExists(sessionFile);
    if (raw === undefined) return false;
    const entries = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseSessionEntry);

    if (entries.length !== 1) return false;
    const only = entries[0] as {
      kind?: unknown;
      parentSessionId?: unknown;
      parentSession?: unknown;
    };
    if (only.kind !== "header") return false;
    if (only.parentSessionId || only.parentSession) return false;
    return true;
  } catch {
    return false;
  }
}

function parseSessionEntry(line: string): { type?: string; kind?: string } {
  return parseJsonValue(
    line,
    (value): value is { type?: string; kind?: string } => isRecord(value),
    (detail, kind) => (kind === "shape" ? "expected a JSON object" : detail),
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
): ParentSessionRef | null {
  if (threadTs !== undefined) {
    const threadTimeMs = Number(threadTs) * 1000;
    if (Number.isFinite(threadTimeMs)) {
      const best = findMainSessionActiveAtTime(sessionsDir, threadTimeMs);
      if (best) return best;
    }
  }
  const path = tryResolveCurrentSession(sessionsDir);
  if (!path) return null;
  const id = readSessionHeaderSummary(path)?.id;
  return id ? { path, id } : null;
}

function mainSessionSummaries(
  sessionDir: string,
): Array<ParentSessionRef & { timestampMs: number }> {
  return readdirSync(sessionDir)
    .filter((name) => MAIN_SESSION_FILENAME.test(name))
    .flatMap((name) => {
      const path = join(sessionDir, name);
      const summary = readSessionHeaderSummary(path);
      return summary ? [{ path, id: summary.id, timestampMs: summary.timestampMs }] : [];
    });
}

function findMainSessionActiveAtTime(
  sessionsDir: string,
  targetMs: number,
): ParentSessionRef | null {
  if (!existsSync(sessionsDir)) return null;
  const started = mainSessionSummaries(sessionsDir).filter(
    (summary) => summary.timestampMs <= targetMs,
  );
  if (started.length === 0) return null;
  const best = started.reduce((a, b) => (b.timestampMs > a.timestampMs ? b : a));
  return { path: best.path, id: best.id };
}

function readSessionHeaderSummary(filePath: string): { id: string; timestampMs: number } | null {
  try {
    const header = SessionStore.readHeader(filePath);
    if (!header) return null;
    const timestampMs = new Date(header.timestamp).getTime();
    return Number.isFinite(timestampMs) ? { id: header.id, timestampMs } : null;
  } catch {
    return null;
  }
}
