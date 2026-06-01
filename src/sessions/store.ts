import { randomUUID } from "crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isRecord, parseJsonValue, readTextFileIfExists } from "../file-guards.js";
import { atomicWritePrivateFile } from "../fs-atomic.js";
import { isPlatformHistorySession } from "./metadata.js";

export class ThreadRootNotFoundError extends Error {
  constructor(sessionFile: string) {
    super(`Thread root message not found in source session: ${sessionFile}`);
    this.name = "ThreadRootNotFoundError";
  }
}

export interface ThreadRootMessage {
  text?: string;
  userName?: string;
  user?: string;
  loggedAt?: number;
  isBot?: boolean;
}

export interface ResolvedSessionScope {
  sessionDir: string;
  contextFile: string;
  threadRootMessage: ThreadRootMessage | null;
}

export interface ResolveGenericSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
}

interface SessionMessageEntryLike {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role?: string;
    timestamp?: number;
    content?: Array<{ type?: string; text?: string }> | string;
  };
}

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
  const base = sessionFile.split("/").pop() ?? sessionFile;
  return base.replace(".jsonl", "").split("_").pop() ?? base;
}

/**
 * Extracts the thread/suffix part of a session key.
 * "channelId:threadId" → "threadId", "channelId" → "channelId"
 */
export function extractSessionSuffix(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : sessionKey;
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uuid = randomUUID().slice(0, 8);
  const filename = `${timestamp}_${uuid}.jsonl`;
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionId = randomUUID();
  const sessionFile = join(sessionDir, `${timestamp}_${sessionId.slice(0, 8)}.jsonl`);
  writeSessionHeader(sessionFile, cwd, sessionId);
  setCurrentPointer(sessionDir, sessionFile);
  return sessionFile;
}

/**
 * Open a session file with an explicit cwd, even if the file does not exist yet.
 * This avoids SessionManager.open() falling back to process.cwd() for fresh sessions.
 */
export function openManagedSession(
  sessionFile: string,
  sessionDir: string,
  cwd: string,
): SessionManager {
  if (shouldRecreatePreinitializedSession(sessionFile)) {
    rmSync(sessionFile, { force: true });
  }

  const SessionManagerCtor = SessionManager as unknown as {
    new (cwd: string, sessionDir: string, sessionFile: string, persist: boolean): SessionManager;
  };
  return new SessionManagerCtor(cwd, sessionDir, sessionFile, true);
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
  const sessionDir = getFileDir(sessionFile);
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

/**
 * Resolve the default session scope for platforms without Slack-style branch forking.
 * Top-level/private sessions use the conversation's current pointer. Threaded or
 * per-message sessions use a fixed file derived from the session key suffix.
 */
export function resolveGenericSessionScope(
  options: ResolveGenericSessionScopeOptions,
): ResolvedSessionScope {
  const { conversationDir, sessionKey } = options;
  const cwd = options.cwd ?? conversationDir;
  const sessionDir = getChannelSessionDir(conversationDir);

  if (!sessionKey.includes(":")) {
    return {
      sessionDir,
      contextFile: resolveManagedSessionFile(sessionDir, cwd),
      threadRootMessage: null,
    };
  }

  const threadFile = getThreadSessionFile(conversationDir, sessionKey);
  return {
    sessionDir,
    contextFile:
      tryResolveThreadSession(threadFile) ?? createManagedSessionFileAtPath(threadFile, cwd),
    threadRootMessage: null,
  };
}

function hasSessionHeader(sessionFile: string): boolean {
  try {
    const raw = readTextFileIfExists(sessionFile);
    if (raw === undefined) return false;
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = parseJsonValue(
        trimmed,
        (value): value is { type?: string } => isRecord(value),
        (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
      );
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
      .map((line) =>
        parseJsonValue(
          line,
          (value): value is { type?: string } => isRecord(value),
          (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
        ),
      );

    return entries.length === 1 && entries[0]?.type === "session";
  } catch {
    return false;
  }
}

function getFileDir(sessionFile: string): string {
  return sessionFile.substring(0, sessionFile.lastIndexOf("/"));
}

function resolveThreadSnapshotEntries(
  sourceSessionFile: string,
  rootMessage: ThreadRootMessage,
): SessionMessageEntryLike[] | null {
  const targetText = buildComparableRootMessageText(rootMessage);
  if (!targetText) return null;

  const entries = SessionManager.open(sourceSessionFile).getEntries() as SessionMessageEntryLike[];
  const matchIndex = findRootMessageIndex(entries, targetText, rootMessage.loggedAt);
  if (matchIndex === -1) return null;

  const nextTopLevelUserIndex = entries.findIndex(
    (entry, index) => index > matchIndex && isUserMessageEntry(entry),
  );
  const endIndex = nextTopLevelUserIndex === -1 ? entries.length : nextTopLevelUserIndex;
  return entries.slice(0, endIndex);
}

function findRootMessageIndex(
  entries: SessionMessageEntryLike[],
  targetText: string,
  loggedAt?: number,
): number {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isUserMessageEntry(entry)) continue;

    const comparableText = normalizeComparableUserText(getMessageText(entry));
    if (comparableText !== targetText) continue;

    const messageTimestamp = entry.message?.timestamp;
    if (
      loggedAt !== undefined &&
      typeof messageTimestamp === "number" &&
      messageTimestamp < loggedAt
    ) {
      continue;
    }

    return i;
  }

  return -1;
}

function isUserMessageEntry(entry: SessionMessageEntryLike): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

function getMessageText(entry: SessionMessageEntryLike): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type?: string; text?: string } => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n\n");
}

function buildComparableRootMessageText(rootMessage: ThreadRootMessage): string | null {
  const text = rootMessage.text?.trim();
  if (!text) return null;
  if (rootMessage.isBot) return text;

  const userLabel = rootMessage.userName || rootMessage.user || "unknown";
  return normalizeComparableUserText(`[${userLabel}]: ${text}`);
}

function stripSlackAttachmentBlock(text: string): string {
  return text.replace(/\n*<slack_attachments>\n[\s\S]*?\n<\/slack_attachments>\s*$/g, "");
}

function normalizeComparableUserText(text: string): string {
  const withoutTimestamp = text.replace(
    /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}\]\s+(?=\[[^\]]+\](?:\s+\[in-thread:[^\]]+\])?:\s)/,
    "",
  );
  return stripSlackAttachmentBlock(withoutTimestamp).trim();
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
 * Resolve the channel's current session file path (for fork source).
 * Returns null if no channel session exists.
 */
export function resolveChannelSessionFile(channelDir: string): string | null {
  return tryResolveCurrentSession(getChannelSessionDir(channelDir));
}

/**
 * Fork a channel session into a fixed thread-session path.
 * The resulting file keeps forkFrom's distinct session/header metadata.
 */
export function forkThreadSessionFile(
  sourceSessionFile: string,
  targetSessionFile: string,
  cwd: string,
): string {
  const sessionDir = getFileDir(targetSessionFile);
  mkdirSync(sessionDir, { recursive: true });
  const forked = SessionManager.forkFrom(sourceSessionFile, cwd, sessionDir);
  const forkedFile = forked.getSessionFile();
  if (!forkedFile) {
    throw new Error(`Failed to fork session from ${sourceSessionFile}`);
  }
  rmSync(targetSessionFile, { force: true });
  renameSync(forkedFile, targetSessionFile);
  return targetSessionFile;
}

export function createThreadSessionFileFromRootMessage(
  targetSessionFile: string,
  cwd: string,
  rootMessage: ThreadRootMessage,
  parentSession?: string,
): string {
  const sessionDir = getFileDir(targetSessionFile);
  mkdirSync(sessionDir, { recursive: true });
  rmSync(targetSessionFile, { force: true });

  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
    ...(parentSession ? { parentSession } : {}),
  };
  const rootText = buildComparableRootMessageText(rootMessage);
  if (!rootText) {
    atomicWritePrivateFile(targetSessionFile, `${JSON.stringify(header)}\n`);
    return targetSessionFile;
  }

  const rootEntry = {
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: rootMessage.isBot ? "assistant" : "user",
      content: [{ type: "text", text: rootText }],
      ...(rootMessage.loggedAt !== undefined ? { timestamp: rootMessage.loggedAt } : {}),
    },
  };
  const content = [header, rootEntry].map((entry) => JSON.stringify(entry)).join("\n");
  atomicWritePrivateFile(targetSessionFile, `${content}\n`);
  return targetSessionFile;
}

export function forkThreadSessionFileFromRootMessage(
  sourceSessionFile: string,
  targetSessionFile: string,
  cwd: string,
  rootMessage: ThreadRootMessage,
): string {
  const snapshotEntries = resolveThreadSnapshotEntries(sourceSessionFile, rootMessage);
  if (!snapshotEntries) {
    throw new ThreadRootNotFoundError(sourceSessionFile);
  }

  const sessionDir = getFileDir(targetSessionFile);
  mkdirSync(sessionDir, { recursive: true });
  rmSync(targetSessionFile, { force: true });

  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
    parentSession: sourceSessionFile,
  };
  const content = [header, ...snapshotEntries].map((entry) => JSON.stringify(entry)).join("\n");
  atomicWritePrivateFile(targetSessionFile, `${content}\n`);
  return targetSessionFile;
}
