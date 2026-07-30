import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import {
  SessionStore,
  type BranchSummaryEntry as SessionBranchSummaryEntry,
  type CompactionEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "../../harness/index.js";
import {
  getThreadSessionFile,
  resolveChannelSessionFile,
  tryResolveThreadSession,
} from "../../sessions/store.js";
import { isPlatformHistorySession } from "../../sessions/store.js";
import { isThreadSessionKey } from "../../sessions/session-key.js";
import * as log from "../../log.js";

export type { SessionViewItem, SessionViewRelation, SessionViewModel } from "./types.js";
import type { SessionHeader } from "../../harness/types.js";
import type { SessionViewItem, SessionViewRelation, SessionViewModel } from "./types.js";

export function resolveExistingSessionFile(
  conversationDir: string,
  sessionKey: string,
): string | null {
  if (isThreadSessionKey(sessionKey)) {
    return tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey));
  }
  return resolveChannelSessionFile(conversationDir);
}

export function loadSessionViewModel(sessionFile: string): SessionViewModel {
  const resolvedFile = resolve(sessionFile);
  const sm = SessionStore.open(resolvedFile);
  const header = sm.getHeader();
  if (!header) throw new Error(`No valid session found: ${sessionFile}`);

  const entries = sm.getEntries();
  const updatedAt = entries.at(-1)?.timestamp ?? header.timestamp;
  const title = sm.getSessionName() || `Session ${header.id.slice(0, 8)}`;

  const parent = resolveParentRelation(resolvedFile, header);
  const threads = listRelatedSessionFiles(resolvedFile)
    .filter((candidate) => candidate !== resolvedFile)
    .map((candidate) => buildSessionRelation(candidate, "thread", resolvedFile, header.id))
    .filter((relation): relation is SessionViewRelation => relation !== null)
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));

  const threadsByEntryId = new Map<string, SessionViewRelation[]>();
  for (const thread of threads) {
    if (!thread.anchorEntryId) continue;
    const bucket = threadsByEntryId.get(thread.anchorEntryId) ?? [];
    bucket.push(thread);
    threadsByEntryId.set(thread.anchorEntryId, bucket);
  }

  const items = entries.flatMap((entry) => {
    const item = mapEntryToItem(entry);
    if (!item) return [];
    if (item.entryId) {
      const anchoredThreads = threadsByEntryId.get(item.entryId);
      if (anchoredThreads) {
        item.threads = anchoredThreads;
      }
    }
    return [item];
  });

  return {
    sessionId: header.id,
    fileName: basename(resolvedFile),
    title,
    createdAt: header.timestamp,
    updatedAt,
    entryCount: entries.length,
    items,
    parent: parent ?? undefined,
    threads,
  };
}

export function resolveRequestedSessionFile(
  baseSessionFile: string,
  requestedFileName?: string | null,
): string | null {
  const resolvedBase = resolve(baseSessionFile);
  if (!requestedFileName) return resolvedBase;

  const trimmed = requestedFileName.trim();
  if (!trimmed) return resolvedBase;

  const fileName = basename(trimmed);
  if (fileName !== trimmed || !fileName.endsWith(".jsonl")) return null;

  const candidate = join(dirname(resolvedBase), fileName);
  if (!existsSync(candidate)) return null;

  let sm: SessionStore;
  try {
    sm = SessionStore.open(candidate);
  } catch (err) {
    throw new Error(
      `Session file is corrupted: ${candidate}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  if (!sm.getHeader()) {
    throw new Error(`Session file is missing a valid header: ${candidate}`);
  }
  return candidate;
}

function listRelatedSessionFiles(sessionFile: string): string[] {
  const dir = dirname(sessionFile);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((fileName) => join(dir, fileName));
}

function buildSessionRelation(
  sessionFile: string,
  kind: "parent" | "thread",
  expectedParent?: string,
  expectedParentId?: string,
): SessionViewRelation | null {
  let sm: SessionStore;
  try {
    sm = SessionStore.open(sessionFile);
  } catch (err) {
    log.logWarning(
      `Skipping corrupted session file while building ${kind} relation: ${sessionFile}`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const header = sm.getHeader();
  if (!header) {
    log.logWarning(
      `Skipping session file with missing header while building ${kind} relation: ${sessionFile}`,
    );
    return null;
  }
  if (
    kind === "thread" &&
    !isChildThreadSession(
      sessionFile,
      header.parentSession,
      expectedParent,
      expectedParentId,
      header.parentSessionId,
    )
  ) {
    return null;
  }

  const entries = sm.getEntries();
  const updatedAt = entries.at(-1)?.timestamp ?? header.timestamp;
  const threadId = kind === "thread" ? getFixedThreadSessionId(sessionFile) : null;
  const anchorEntryId =
    kind === "thread" && expectedParent
      ? findThreadAnchorEntryId(SessionStore.open(expectedParent).getEntries(), entries, threadId)
      : undefined;
  return {
    kind,
    fileName: basename(sessionFile),
    sessionId: header.id,
    title: sm.getSessionName() || `Session ${header.id.slice(0, 8)}`,
    updatedAt,
    entryCount: entries.length,
    summary: extractSessionSummary(entries),
    anchorEntryId,
  };
}

function resolveParentRelation(
  sessionFile: string,
  header: SessionHeader,
): SessionViewRelation | undefined {
  if (header.parentSession) {
    const parentPath = resolve(header.parentSession);
    if (existsSync(parentPath)) {
      return buildSessionRelation(parentPath, "parent") ?? undefined;
    }
    // Path is stale — try UUID fallback before heuristic.
    if (header.parentSessionId) {
      const found = findSessionFileById(dirname(sessionFile), header.parentSessionId);
      if (found) return buildSessionRelation(found, "parent") ?? undefined;
    }
  }
  return buildInferredThreadParentRelation(sessionFile);
}

function findSessionFileById(sessionDir: string, targetId: string): string | null {
  if (!existsSync(sessionDir)) return null;
  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const filePath = join(sessionDir, name);
      const sm = SessionStore.open(filePath);
      if (sm.getHeader()?.id === targetId) return filePath;
    } catch {
      continue;
    }
  }
  return null;
}

function buildInferredThreadParentRelation(sessionFile: string): SessionViewRelation | undefined {
  if (!getFixedThreadSessionId(sessionFile)) return undefined;

  const parentSession = resolveChannelSessionFile(dirname(dirname(sessionFile)));
  if (!parentSession || parentSession === sessionFile) return undefined;

  return buildSessionRelation(parentSession, "parent") ?? undefined;
}

function isChildThreadSession(
  sessionFile: string,
  parentSession: string | undefined,
  expectedParent: string | undefined,
  expectedParentId?: string,
  threadParentSessionId?: string,
): boolean {
  if (!expectedParent) return false;

  if (parentSession) {
    const resolvedParent = resolve(parentSession);
    if (
      resolvedParent === expectedParent ||
      (isPlatformHistorySession(expectedParent) && isPlatformHistorySession(resolvedParent))
    ) {
      return true;
    }
    // Path is stale — fall back to UUID comparison.
    if (expectedParentId && threadParentSessionId) {
      return threadParentSessionId === expectedParentId;
    }
    return false;
  }

  if (!getFixedThreadSessionId(sessionFile)) return false;
  return resolveChannelSessionFile(dirname(dirname(sessionFile))) === expectedParent;
}

function getFixedThreadSessionId(sessionFile: string): string | null {
  const fileName = basename(sessionFile);
  if (!fileName.endsWith(".jsonl")) return null;
  if (/^\d{4}-\d{2}-\d{2}T.+_[0-9a-f]{8}\.jsonl$/i.test(fileName)) return null;
  return fileName.slice(0, -".jsonl".length);
}

function findThreadAnchorEntryId(
  parentEntries: SessionEntry[],
  childEntries: SessionEntry[],
  threadId: string | null,
): string | undefined {
  const threadTimestamp = parseThreadTimestamp(threadId);
  if (threadTimestamp !== undefined) {
    const timestampAnchor = findEntryIdByMessageTimestamp(parentEntries, threadTimestamp);
    if (timestampAnchor) return timestampAnchor;
  }
  let sharedCount = 0;
  while (
    sharedCount < parentEntries.length &&
    sharedCount < childEntries.length &&
    parentEntries[sharedCount]?.id === childEntries[sharedCount]?.id
  ) {
    sharedCount += 1;
  }

  if (sharedCount > 0) {
    return parentEntries[sharedCount - 1]?.id;
  }

  const contentAnchor = findSharedContentAnchorEntryId(parentEntries, childEntries);
  if (contentAnchor) return contentAnchor;

  const childRoot = findComparableUserMessage(childEntries);
  if (!childRoot) return undefined;

  return findParentAnchorByRootMessage(parentEntries, childRoot);
}

function parseThreadTimestamp(threadId: string | null): number | undefined {
  if (!threadId) return undefined;
  const timestamp = Number(threadId) * 1000;
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function findEntryIdByMessageTimestamp(
  entries: SessionEntry[],
  timestamp: number,
): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const messageTimestamp = (entry.message as { timestamp?: unknown }).timestamp;
    if (messageTimestamp === timestamp) return entry.id;
  }
  return undefined;
}

function findSharedContentAnchorEntryId(
  parentEntries: SessionEntry[],
  childEntries: SessionEntry[],
): string | undefined {
  const parentMessages = parentEntries.flatMap((entry) => {
    const comparable = getComparableSessionMessage(entry);
    return comparable ? [comparable] : [];
  });
  const childMessages = childEntries.flatMap((entry) => {
    const comparable = getComparableSessionMessage(entry);
    return comparable ? [comparable] : [];
  });
  if (parentMessages.length === 0 || childMessages.length === 0) return undefined;

  let bestParentEnd = -1;
  let bestLength = 0;
  for (let parentStart = 0; parentStart < parentMessages.length; parentStart++) {
    let length = 0;
    while (parentStart + length < parentMessages.length && length < childMessages.length) {
      const parentMessage = parentMessages[parentStart + length];
      const childMessage = childMessages[length];
      if (
        parentMessage === undefined ||
        childMessage === undefined ||
        !comparableSessionMessagesMatch(parentMessage, childMessage)
      ) {
        break;
      }
      length += 1;
    }
    if (length > bestLength) {
      bestLength = length;
      bestParentEnd = parentStart + length - 1;
    }
  }

  return bestLength > 0 ? parentMessages[bestParentEnd]?.entryId : undefined;
}

interface ComparableSessionMessage {
  entryId: string;
  role: "user" | "assistant";
  normalizedText: string;
}

function getComparableSessionMessage(entry: SessionEntry): ComparableSessionMessage | null {
  if (entry.type !== "message") return null;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return null;

  const body = contentToText(entry.message.content);
  const normalizedText = normalizeComparableSessionText(body, role);
  if (!normalizedText) return null;

  return { entryId: entry.id, role, normalizedText };
}

function comparableSessionMessagesMatch(
  parent: ComparableSessionMessage,
  child: ComparableSessionMessage,
): boolean {
  return parent.role === child.role && parent.normalizedText === child.normalizedText;
}

function normalizeComparableSessionText(text: string, role: "user" | "assistant"): string {
  const normalized = role === "user" ? normalizeComparableUserText(text) : text.trim();
  return normalized.replace(/\s+/g, " ").trim();
}

function findParentAnchorByRootMessage(
  parentEntries: SessionEntry[],
  childRoot: ComparableUserMessage,
): string | undefined {
  let textMatchId: string | undefined;

  for (const entry of parentEntries) {
    const comparable = getComparableUserMessage(entry);
    if (!comparable) continue;
    if (comparable.normalizedText !== childRoot.normalizedText) continue;
    if (
      childRoot.messageTimestamp !== undefined &&
      comparable.messageTimestamp !== undefined &&
      comparable.messageTimestamp === childRoot.messageTimestamp
    ) {
      return entry.id;
    }
    textMatchId ??= entry.id;
  }

  return textMatchId;
}

interface ComparableUserMessage {
  normalizedText: string;
  messageTimestamp?: number;
}

function findComparableUserMessage(entries: SessionEntry[]): ComparableUserMessage | null {
  for (const entry of entries) {
    const comparable = getComparableUserMessage(entry);
    if (comparable) return comparable;
  }
  return null;
}

function getComparableUserMessage(entry: SessionEntry): ComparableUserMessage | null {
  if (entry.type !== "message" || entry.message.role !== "user") return null;

  const body = contentToText(entry.message.content);
  const normalizedText = normalizeComparableUserText(body);
  if (!normalizedText) return null;

  const messageTimestamp =
    typeof entry.message.timestamp === "number" ? entry.message.timestamp : undefined;
  return { normalizedText, messageTimestamp };
}

function normalizeComparableUserText(text: string): string {
  const withoutTimestamp = text.replace(
    /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}\]\s+(?=\[[^\]]+\](?:\s+\[in-thread:[^\]]+\])?:\s)/,
    "",
  );
  return stripSlackAttachmentBlock(withoutTimestamp).trim();
}

function stripSlackAttachmentBlock(text: string): string {
  return text.replace(/\n*<slack_attachments>\n[\s\S]*?\n<\/slack_attachments>\s*$/g, "");
}

function extractSessionSummary(entries: SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const item = mapEntryToItem(entry);
    if (!item?.body) continue;
    return collapseSummary(item.body);
  }
  return undefined;
}

function collapseSummary(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 96 ? `${singleLine.slice(0, 93)}…` : singleLine;
}

function mapEntryToItem(entry: SessionEntry): SessionViewItem | null {
  switch (entry.type) {
    case "message":
      return mapMessageEntry(entry);
    case "model_change":
      return {
        kind: "system",
        title: "Model changed",
        body: `${entry.provider} / ${entry.modelId}`,
        meta: entry.timestamp,
        tone: "muted",
      };
    case "thinking_level_change":
      return {
        kind: "system",
        title: "Thinking level changed",
        body: entry.thinkingLevel,
        meta: entry.timestamp,
        tone: "muted",
      };
    case "compaction":
      return mapCompactionEntry(entry);
    case "branch_summary":
      return mapSessionSummaryEntry(entry);
    case "custom_message":
      return {
        kind: "system",
        title: `Custom message · ${entry.customType}`,
        body: contentToText(entry.content),
        meta: entry.timestamp,
        tone: "muted",
      };
    case "custom":
      return {
        kind: "system",
        title: `Custom data · ${entry.customType}`,
        body: entry.data === undefined ? "(no data)" : JSON.stringify(entry.data, null, 2),
        meta: entry.timestamp,
        tone: "muted",
      };
    case "label":
      return {
        kind: "system",
        title: "Label updated",
        body: entry.label || "(cleared)",
        meta: entry.timestamp,
        tone: "muted",
      };
    case "session_info":
      return entry.name
        ? {
            kind: "system",
            title: "Session renamed",
            body: entry.name,
            meta: entry.timestamp,
            tone: "muted",
          }
        : null;
    default:
      return null;
  }
}

function mapMessageEntry(entry: SessionMessageEntry): SessionViewItem {
  const message = entry.message as unknown as Record<string, unknown> & {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
    toolName?: string;
    isError?: boolean;
    command?: string;
    output?: string;
    exitCode?: number;
    cancelled?: boolean;
    truncated?: boolean;
    stopReason?: string;
    errorMessage?: string;
    customType?: string;
    summary?: string;
  };

  switch (message.role) {
    case "user":
      return {
        kind: "user",
        title: "User",
        body: contentToText(message.content),
        meta: entry.timestamp,
        entryId: entry.id,
      };
    case "assistant": {
      const assistantBody =
        contentToText(message.content) || (message.errorMessage ? `_${message.errorMessage}_` : "");
      const metaParts = [message.provider, message.model, message.stopReason].filter(Boolean);
      return {
        kind: "assistant",
        title: "Assistant",
        body: assistantBody,
        meta:
          metaParts.length > 0 ? `${entry.timestamp} · ${metaParts.join(" · ")}` : entry.timestamp,
        entryId: entry.id,
      };
    }
    case "toolResult":
      return {
        kind: "tool",
        title: `Tool result · ${String(message.toolName ?? "unknown")}`,
        body: contentToText(message.content),
        meta: entry.timestamp,
        tone: message.isError ? "err" : "ok",
        entryId: entry.id,
      };
    case "bashExecution": {
      const command = String(message.command ?? "").trim();
      const output = String(message.output ?? "").trim();
      const details = [
        typeof message.exitCode === "number" ? `[exitCode] ${message.exitCode}` : "",
        message.cancelled ? `[cancelled] true` : "",
        message.truncated ? `[truncated] true` : "",
      ].filter(Boolean);
      const body = [command ? `$ ${command}` : "", output, ...details].filter(Boolean).join("\n\n");
      return {
        kind: "tool",
        title: "Bash execution",
        body: body || "(no output)",
        meta: entry.timestamp,
        entryId: entry.id,
      };
    }
    case "custom":
      return {
        kind: "system",
        title: `Custom message · ${String(message.customType ?? "custom")}`,
        body: contentToText(message.content),
        meta: entry.timestamp,
        tone: "muted",
        entryId: entry.id,
      };
    case "branchSummary":
      return {
        kind: "system",
        title: "Session summary",
        body: String(message.summary ?? ""),
        meta: entry.timestamp,
        tone: "muted",
        entryId: entry.id,
      };
    case "compactionSummary":
      return {
        kind: "system",
        title: "Compaction summary",
        body: String(message.summary ?? ""),
        meta: entry.timestamp,
        tone: "muted",
        entryId: entry.id,
      };
    default:
      return {
        kind: "system",
        title: `Message · ${String(message.role ?? "unknown")}`,
        body: contentToText(message.content),
        meta: entry.timestamp,
        tone: "muted",
        entryId: entry.id,
      };
  }
}

function mapCompactionEntry(entry: CompactionEntry): SessionViewItem {
  return {
    kind: "system",
    title: "Context compacted",
    body: entry.summary,
    meta: `${entry.timestamp} · ${entry.tokensBefore} tokens before compaction`,
    tone: "muted",
  };
}

function mapSessionSummaryEntry(entry: SessionBranchSummaryEntry): SessionViewItem {
  return {
    kind: "system",
    title: "Session summary",
    body: entry.summary,
    meta: entry.timestamp,
    tone: "muted",
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const lines: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      lines.push(value.text);
      continue;
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      lines.push(`[thinking]\n${value.thinking}`);
      continue;
    }
    if (value.type === "toolCall") {
      const name = typeof value.name === "string" ? value.name : "tool";
      const args = value.arguments === undefined ? "" : JSON.stringify(value.arguments, null, 2);
      lines.push([`[toolCall] ${name}`, args].filter(Boolean).join("\n"));
      continue;
    }
    if (value.type === "image") {
      lines.push(`[image ${String(value.mimeType ?? "unknown")}]`);
    }
  }

  return lines.join("\n\n");
}
