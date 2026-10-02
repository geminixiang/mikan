import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { JsonValue } from "@earendil-works/chord";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { isRecord } from "../unknown-values.js";
import { wrapCompactionSummary } from "../sessions/compaction-summary.js";

const V4_SESSION_VERSION = 4;

export interface V4CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface V4BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

export interface V4CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export type V4Message =
  | Message
  | V4CompactionSummaryMessage
  | V4BranchSummaryMessage
  | V4CustomMessage;

interface V4EntryBase {
  id: string;
  parentId: string | null;
  seq?: number;
  timestamp: number;
}

export type V4Entry = V4EntryBase &
  (
    | { type: "message"; message: V4Message }
    | {
        type: "compaction";
        summary: string;
        retainedTail: V4Message[];
        tokensBefore: number;
        details?: JsonValue;
        usage?: Usage;
        fromHook: boolean;
      }
    | {
        type: "branch_summary";
        fromId: string | null;
        summary: string;
        details?: JsonValue;
        usage?: Usage;
        fromHook: boolean;
      }
    | { type: "custom"; customType: string; data?: JsonValue }
  );

export interface V4SessionHeader {
  v: typeof V4_SESSION_VERSION;
  kind: "header";
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
}

export interface V4Session {
  header: V4SessionHeader;
  branch: V4Entry[];
  name?: string;
  parentSessionPath?: string;
  source?: { [key: string]: JsonValue };
  open: boolean;
}

export function compactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: number,
): V4CompactionSummaryMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp };
}

export function branchSummaryMessage(
  summary: string,
  fromId: string | null,
  timestamp: number,
): V4BranchSummaryMessage {
  return { role: "branchSummary", summary, fromId, timestamp };
}

export function customMessage(
  customType: string,
  content: V4CustomMessage["content"],
  display: boolean,
  details: unknown,
  timestamp: number,
): V4CustomMessage {
  return { role: "custom", customType, content, display, details, timestamp };
}

const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

const HEADER_PROBE_BYTES = 64 * 1024;

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf-8").split("\n", 1)[0] ?? "";
  } finally {
    closeSync(fd);
  }
}

export function readV4Header(path: string): V4SessionHeader | undefined {
  const firstLine = readFirstLine(path);
  let value: unknown;
  try {
    value = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.kind !== "header" ||
    value.v !== V4_SESSION_VERSION ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.cwd !== "string"
  ) {
    return undefined;
  }
  return {
    v: V4_SESSION_VERSION,
    kind: "header",
    id: value.id,
    createdAt: value.createdAt,
    cwd: value.cwd,
    parentSessionId: typeof value.parentSessionId === "string" ? value.parentSessionId : undefined,
    legacyParentSessionPath:
      typeof value.legacyParentSessionPath === "string" ? value.legacyParentSessionPath : undefined,
  };
}

function isV4Entry(record: Record<string, unknown>): boolean {
  return (
    record.kind === "entry" &&
    typeof record.id === "string" &&
    (record.parentId === null || typeof record.parentId === "string") &&
    typeof record.type === "string"
  );
}

function asV4Entry(record: Record<string, unknown>): V4Entry {
  const { kind: _kind, seq: _seq, ...entry } = record;
  const parsed: V4Entry = JSON.parse(JSON.stringify(entry));
  return parsed;
}

export function readV4Session(path: string): V4Session {
  const header = readV4Header(path);
  if (!header) throw new Error(`Not a v4 session file: ${path}`);
  const content = readFileSync(path, "utf-8");
  const complete = content.endsWith("\n") ? content : content.slice(0, content.lastIndexOf("\n"));
  const entries = new Map<string, V4Entry>();
  const values = new Map<string, unknown>();
  const lines = complete.split("\n").slice(1);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let transaction: unknown;
    try {
      transaction = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid v4 session ${path}: line ${index + 2}`, { cause: error });
    }
    for (const record of Array.isArray(transaction) ? transaction : [transaction]) {
      if (!isRecord(record)) continue;
      if (isV4Entry(record)) {
        const entry = asV4Entry(record);
        entries.set(entry.id, entry);
      } else if (
        record.kind === "value" &&
        typeof record.namespace === "string" &&
        typeof record.key === "string"
      ) {
        const address = `${record.namespace}\u0000${record.key}`;
        if (record.op === "delete") values.delete(address);
        else if (record.op === "set") values.set(address, record.value);
      }
    }
  }
  const tip = values.get("pi.branch.tip\u0000main");
  const branch: V4Entry[] = [];
  let current = typeof tip === "string" ? entries.get(tip) : undefined;
  while (current) {
    branch.push(current);
    current = current.parentId === null ? undefined : entries.get(current.parentId);
  }
  const name = values.get("pi.session.name\u0000");
  const metadata = values.get("mikan\u0000metadata");
  const lane = values.get("pi.lane.state\u0000main");
  return {
    header,
    branch: branch.toReversed(),
    name: typeof name === "string" && name.trim() ? name.trim() : undefined,
    parentSessionPath:
      isRecord(metadata) && typeof metadata.parentSessionPath === "string"
        ? metadata.parentSessionPath
        : header.legacyParentSessionPath,
    source:
      isRecord(metadata) && isRecord(metadata.source)
        ? JSON.parse(JSON.stringify(metadata.source))
        : undefined,
    open: isRecord(lane) && lane.currentOperationId != null,
  };
}

export function isContextMessage(message: V4Message): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

export function buildV4Context(branch: V4Entry[]): V4Message[] {
  const compactionIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const messages: V4Message[] = [];
  for (const entry of branch.slice(Math.max(0, compactionIndex))) {
    if (entry.type === "message") {
      if (isContextMessage(entry.message)) messages.push(entry.message);
    } else if (entry.type === "compaction") {
      messages.push(
        compactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
        ...entry.retainedTail.filter(isContextMessage),
      );
    } else if (entry.type === "branch_summary" && entry.summary) {
      messages.push(branchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  }
  return messages;
}

export function toModelMessage(
  message: V4Message,
): UserMessage | AssistantMessage | ToolResultMessage | undefined {
  switch (message.role) {
    case "user":
    case "assistant":
    case "toolResult":
      return message;
    case "custom":
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content,
        timestamp: message.timestamp,
      };
    case "branchSummary":
      return {
        role: "user",
        content: [
          { type: "text", text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX },
        ],
        timestamp: message.timestamp,
      };
    case "compactionSummary":
      return {
        role: "user",
        content: [{ type: "text", text: wrapCompactionSummary(message.summary) }],
        timestamp: message.timestamp,
      };
    default:
      return undefined;
  }
}
