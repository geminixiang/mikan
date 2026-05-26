import { basename, dirname, join, resolve } from "path";
import { existsSync, readdirSync } from "fs";
import {
  SessionManager,
  type BranchSummaryEntry,
  type CompactionEntry,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getThreadSessionFile,
  resolveChannelSessionFile,
  tryResolveThreadSession,
} from "../sessions/store.js";
import { isPlatformHistorySession } from "../sessions/metadata.js";
import * as log from "../log.js";

export interface SessionViewItem {
  kind: "user" | "assistant" | "tool" | "system";
  title: string;
  body?: string;
  meta?: string;
  tone?: "default" | "ok" | "err" | "muted";
  entryId?: string;
  forks?: SessionViewRelation[];
}

export interface SessionViewRelation {
  kind: "parent" | "fork";
  fileName: string;
  sessionId: string;
  title: string;
  updatedAt: string;
  entryCount: number;
  summary?: string;
  anchorEntryId?: string;
}

export interface SessionViewModel {
  sessionId: string;
  fileName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  items: SessionViewItem[];
  parent?: SessionViewRelation;
  forks: SessionViewRelation[];
}

export function resolveExistingSessionFile(
  workingDir: string,
  conversationId: string,
  sessionKey: string,
): string | null {
  const conversationDir = join(workingDir, conversationId);
  if (sessionKey.includes(":")) {
    return tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey));
  }
  return resolveChannelSessionFile(conversationDir);
}

export function loadSessionViewModel(sessionFile: string): SessionViewModel {
  const resolvedFile = resolve(sessionFile);
  const sm = SessionManager.open(resolvedFile);
  const header = sm.getHeader();
  if (!header) throw new Error(`No valid session found: ${sessionFile}`);

  const entries = sm.getEntries();
  const updatedAt = entries.at(-1)?.timestamp ?? header.timestamp;
  const title = sm.getSessionName() || `Session ${header.id.slice(0, 8)}`;

  const parent = header.parentSession
    ? buildSessionRelation(resolve(header.parentSession), "parent")
    : undefined;
  const forks = listRelatedSessionFiles(resolvedFile)
    .filter((candidate) => candidate !== resolvedFile)
    .map((candidate) => buildSessionRelation(candidate, "fork", resolvedFile))
    .filter((relation): relation is SessionViewRelation => relation !== null)
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));

  const forksByEntryId = new Map<string, SessionViewRelation[]>();
  for (const fork of forks) {
    if (!fork.anchorEntryId) continue;
    const bucket = forksByEntryId.get(fork.anchorEntryId) ?? [];
    bucket.push(fork);
    forksByEntryId.set(fork.anchorEntryId, bucket);
  }

  const items = entries.flatMap((entry) => {
    const item = mapEntryToItem(entry);
    if (!item) return [];
    if (item.entryId) {
      const anchoredForks = forksByEntryId.get(item.entryId);
      if (anchoredForks) {
        item.forks = anchoredForks;
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
    forks,
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

  let sm: SessionManager;
  try {
    sm = SessionManager.open(candidate);
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
  kind: "parent" | "fork",
  expectedParent?: string,
): SessionViewRelation | null {
  let sm: SessionManager;
  try {
    sm = SessionManager.open(sessionFile);
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
  if (kind === "fork") {
    const parentSession = resolve(header.parentSession ?? "");
    if (
      parentSession !== expectedParent &&
      !(
        expectedParent &&
        isPlatformHistorySession(expectedParent) &&
        isPlatformHistorySession(parentSession)
      )
    ) {
      return null;
    }
  }

  const entries = sm.getEntries();
  const updatedAt = entries.at(-1)?.timestamp ?? header.timestamp;
  const anchorEntryId =
    kind === "fork" && expectedParent
      ? findForkAnchorEntryId(SessionManager.open(expectedParent).getEntries(), entries)
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

function findForkAnchorEntryId(
  parentEntries: SessionEntry[],
  childEntries: SessionEntry[],
): string | undefined {
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

  const childRoot = findComparableUserMessage(childEntries);
  if (!childRoot) return undefined;

  return findParentAnchorByRootMessage(parentEntries, childRoot);
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
      return mapBranchSummaryEntry(entry);
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
        assistantContentToText(message.content) ||
        (message.errorMessage ? `_${message.errorMessage}_` : "");
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
        title: "Branch summary",
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

function mapBranchSummaryEntry(entry: BranchSummaryEntry): SessionViewItem {
  return {
    kind: "system",
    title: "Branch summary",
    body: entry.summary,
    meta: entry.timestamp,
    tone: "muted",
  };
}

function assistantContentToText(content: unknown): string {
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
