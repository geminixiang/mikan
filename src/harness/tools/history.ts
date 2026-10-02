import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { Office } from "../../office/types.js";
import { readConversationLog } from "../../sessions/chat-history-sync.js";
import { formatHistoryLine, formatLocalTimestamp } from "../../sessions/history-line.js";
import { SessionStore } from "../../sessions/session-store.js";
import { listOfficeSessions } from "../../sessions/store.js";
import type { OfficeSessionInfo, SessionEntry } from "../../sessions/types.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";

const HISTORY_TOOL = "history";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_ENTRY_CHARS = 2000;
const MAX_OUTPUT_CHARS = 30_000;
const SESSION_REF_MIN_CHARS = 8;

const historySchema = Type.Object({
  label: LABEL_PARAMETER,
  action: Type.Union(
    [Type.Literal("sessions"), Type.Literal("search"), Type.Literal("read"), Type.Literal("chat")],
    {
      description:
        "sessions: list this conversation's sessions. search: find text in session entries, including tool calls and output. read: read one session in order. chat: search the chat log, including messages you never answered.",
    },
  ),
  query: Type.Optional(
    Type.String({
      description: "Case-insensitive text to find (search and chat; optional for chat)",
    }),
  ),
  session: Type.Optional(
    Type.String({
      description: `Session id from the sessions action (first ${SESSION_REF_MIN_CHARS}+ characters are enough), or "current". read defaults to current; search defaults to every session.`,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `How many of the newest results to return (default ${DEFAULT_LIMIT}; sessions lists up to ${MAX_LIMIT})`,
    }),
  ),
  skip: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Newest results to skip, to page back to older ones",
    }),
  ),
});

type HistoryArgs = Omit<Static<typeof historySchema>, "label">;

interface HistoryScope {
  office: Office;
  sessionFile: string;
}

function isScopeSession(info: OfficeSessionInfo, scope: HistoryScope): boolean {
  return resolve(info.file) === resolve(scope.sessionFile);
}

function clip(text: string, max = MAX_ENTRY_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

function formatTime(ms: number): string {
  return formatLocalTimestamp(new Date(ms)) ?? String(ms);
}

interface HistoryEntry {
  timestamp: number;
  text: string;
}

function toolResultText(message: ToolResultMessage): string {
  return `[${message.toolName}${message.isError ? " error" : ""}] ${contentText(message.content, "\n")}`;
}

function messageText(
  message: AgentMessage,
  results: ReadonlyMap<string, ToolResultMessage>,
): string | undefined {
  switch (message.role) {
    case "user":
      return `[user] ${contentText(message.content, "\n")}`;
    case "assistant": {
      const parts = message.content.flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type !== "toolCall") return [];
        const call = `→ ${part.name} ${JSON.stringify(part.arguments)}`;
        const result = part.name === HISTORY_TOOL ? undefined : results.get(part.id);
        return [result ? `${call}\n← ${toolResultText(result)}` : call];
      });
      return parts.length > 0 ? `[assistant] ${parts.join("\n")}` : undefined;
    }
    case "toolResult":
      return message.toolName === HISTORY_TOOL ? undefined : toolResultText(message);
    default:
      return undefined;
  }
}

function historyEntries(entries: readonly SessionEntry[]): HistoryEntry[] {
  const calls = new Set<string>();
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
    if (entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) if (part.type === "toolCall") calls.add(part.id);
  }
  return entries.flatMap((entry) => {
    switch (entry.type) {
      case "message": {
        const { message } = entry;
        if (message.role === "toolResult" && calls.has(message.toolCallId)) return [];
        const text = messageText(message, results);
        return text ? [{ timestamp: entry.timestamp, text }] : [];
      }
      case "compaction":
        return [{ timestamp: entry.timestamp, text: `[summary] ${entry.summary}` }];
      case "custom":
        return [];
    }
  });
}

function matches(text: string, query: string | undefined): boolean {
  return !query || text.toLowerCase().includes(query);
}

function entryLine(entry: HistoryEntry): string {
  return `(${formatTime(entry.timestamp)}) ${clip(entry.text)}`;
}

function newestPage<T>(items: readonly T[], args: HistoryArgs): T[] {
  const end = Math.max(items.length - (args.skip ?? 0), 0);
  return items.slice(Math.max(end - (args.limit ?? DEFAULT_LIMIT), 0), end);
}

function bounded(header: string, lines: readonly string[], skip: number): string {
  const kept: string[] = [];
  let length = header.length;
  for (const line of lines.toReversed()) {
    if (length + line.length > MAX_OUTPUT_CHARS) break;
    kept.unshift(line);
    length += line.length;
  }
  const dropped = lines.length - kept.length;
  const note =
    dropped > 0
      ? [`(${dropped} older results omitted by the output limit; use skip=${skip + kept.length})`]
      : [];
  return [header, ...note, ...kept].join("\n\n");
}

const SESSION_KIND_LABELS: Record<OfficeSessionInfo["kind"], string> = {
  main: "main",
  scoped: "thread",
  archived: "reset thread",
};

function sessionLabel(info: OfficeSessionInfo, titles: ReadonlyMap<string, string>): string {
  const kind = info.current ? "main, current" : SESSION_KIND_LABELS[info.kind];
  const title = info.scopeId ? titles.get(info.scopeId) : undefined;
  const parent = info.header.parentSessionId
    ? ` parent=${info.header.parentSessionId.slice(0, SESSION_REF_MIN_CHARS)}`
    : "";
  return `${info.header.id} (${kind}, ${formatTime(info.header.createdAt)}${parent})${title ? ` ${clip(title, 120)}` : ""}`;
}

function scopeTitles(office: Office): Map<string, string> {
  const titles = new Map<string, string>();
  for (const { message } of readConversationLog(office)) {
    const firstLine = message.text
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim();
    if (message.ts && firstLine) {
      titles.set(message.ts, `[${message.userName ?? message.user ?? "unknown"}]: ${firstLine}`);
    }
  }
  return titles;
}

function resolveSession(
  sessions: readonly OfficeSessionInfo[],
  scope: HistoryScope,
  ref: string,
): OfficeSessionInfo | string {
  if (ref === "current") {
    return (
      sessions.find((info) => isScopeSession(info, scope)) ?? "The current session has no file yet."
    );
  }
  if (ref.length < SESSION_REF_MIN_CHARS) {
    return `Use at least ${SESSION_REF_MIN_CHARS} characters of a session id.`;
  }
  const found = sessions.filter((info) => info.header.id.startsWith(ref));
  const [only] = found;
  if (found.length === 1 && only) return only;
  return found.length === 0
    ? `No session in this conversation starts with "${ref}". Use the sessions action to list them.`
    : `"${ref}" matches ${found.length} sessions; use more characters.`;
}

function listSessions(scope: HistoryScope, args: HistoryArgs): string {
  const sessions = listOfficeSessions(scope.office.sessionsDir);
  if (sessions.length === 0) return "This conversation has no sessions yet.";
  const titles = scopeTitles(scope.office);
  const lines = sessions
    .map((info) => `${isScopeSession(info, scope) ? "* " : ""}${sessionLabel(info, titles)}`)
    .toReversed();
  return bounded(
    `${sessions.length} sessions in this conversation, oldest first; * marks this one.`,
    newestPage(lines, { ...args, limit: args.limit ?? MAX_LIMIT }),
    args.skip ?? 0,
  );
}

async function sessionEntries(info: OfficeSessionInfo): Promise<HistoryEntry[]> {
  return historyEntries(await (await SessionStore.inspect(info.file)).getEntries());
}

async function readSession(scope: HistoryScope, args: HistoryArgs): Promise<string> {
  const sessions = listOfficeSessions(scope.office.sessionsDir);
  const info = resolveSession(sessions, scope, args.session ?? "current");
  if (typeof info === "string") return info;
  const query = args.query?.trim().toLowerCase();
  const found = (await sessionEntries(info)).filter((entry) => matches(entry.text, query));
  if (found.length === 0) {
    return query ? `No entries match "${args.query}".` : "The session is empty.";
  }
  const page = newestPage(found, args);
  return bounded(
    `Session ${sessionLabel(info, scopeTitles(scope.office))}: ${found.length} entries; ${page.length} newest shown, oldest first.`,
    page.map(entryLine),
    args.skip ?? 0,
  );
}

async function searchSessions(scope: HistoryScope, args: HistoryArgs): Promise<string> {
  const query = args.query?.trim().toLowerCase();
  if (!query) return "search needs a query; use read to page through a session.";
  const sessions = listOfficeSessions(scope.office.sessionsDir);
  const selected = args.session ? resolveSession(sessions, scope, args.session) : undefined;
  if (typeof selected === "string") return selected;
  const titles = scopeTitles(scope.office);
  const results: Array<HistoryEntry & { session: OfficeSessionInfo }> = [];
  for (const info of selected ? [selected] : sessions) {
    for (const entry of await sessionEntries(info)) {
      if (matches(entry.text, query)) results.push({ ...entry, session: info });
    }
  }
  if (results.length === 0) return `No session entries match "${args.query}".`;
  const page = newestPage(
    results.toSorted((a, b) => a.timestamp - b.timestamp),
    args,
  );
  const lines = page.map((result, index) => {
    const line = entryLine(result);
    return page[index - 1]?.session === result.session
      ? line
      : `## session ${sessionLabel(result.session, titles)}\n${line}`;
  });
  const sessionCount = new Set(results.map((result) => result.session)).size;
  return bounded(
    `${results.length} matching entries in ${sessionCount} sessions; ${page.length} newest shown, oldest first, grouped by session.`,
    lines,
    args.skip ?? 0,
  );
}

function searchChat(scope: HistoryScope, args: HistoryArgs): string {
  const query = args.query?.trim().toLowerCase();
  const lines = readConversationLog(scope.office)
    .map(({ message }) =>
      formatHistoryLine({
        date: message.date ? new Date(message.date) : undefined,
        userName: message.userName ?? message.user,
        threadTs: message.threadTs,
        text: message.text ?? "",
      }),
    )
    .filter((line) => matches(line, query));
  if (lines.length === 0) {
    return query ? `No chat messages match "${args.query}".` : "The chat log is empty.";
  }
  const page = newestPage(lines, args);
  return bounded(
    `${lines.length} ${query ? "matching " : ""}chat messages; ${page.length} newest shown, oldest first.`,
    page.map((line) => clip(line)),
    args.skip ?? 0,
  );
}

export async function runHistory(scope: HistoryScope, args: HistoryArgs): Promise<string> {
  switch (args.action) {
    case "sessions":
      return listSessions(scope, args);
    case "search":
      return searchSessions(scope, args);
    case "read":
      return readSession(scope, args);
    case "chat":
      return searchChat(scope, args);
  }
}

export function createHistoryTool(scope: HistoryScope): AgentTool<typeof historySchema> {
  return {
    name: HISTORY_TOOL,
    label: HISTORY_TOOL,
    description:
      "Look back through this conversation's history beyond your context: its sessions (the channel or DM session, earlier ones replaced by /new, and its threads), their messages, your tool calls and their output, and the chat log. Read an earlier result here instead of rerunning its command. Other conversations are not reachable.",
    parameters: historySchema,
    execute: async (_toolCallId, { label: _label, ...args }, signal) => {
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: await runHistory(scope, args) }],
        details: undefined,
      };
    },
  };
}
