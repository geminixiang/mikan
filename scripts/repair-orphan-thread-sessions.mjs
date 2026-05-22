#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.dataDir || args.help) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const rootDataDir = resolve(args.dataDir);
const historyDays = Number(args.days ?? 14);
const messageLimit = Number(args.maxMessages ?? 200);
const dryRun = args.dryRun !== false;
const runAt = new Date();
const rootBackupDir = join(rootDataDir, `.migration-backup-${stamp(runAt)}-orphan-threads`);
const conversationIds = args.conversation
  ? [String(args.conversation)]
  : listConversations(rootDataDir);
const report = [];

for (const conversationId of conversationIds) {
  const conversationDir = join(rootDataDir, conversationId);
  const sessionDir = join(conversationDir, "sessions");
  const logFile = join(conversationDir, "log.jsonl");
  if (!existsSync(sessionDir) || !existsSync(logFile)) continue;

  const parent = ensureHistoryParent({ conversationDir, sessionDir, logFile });
  if (!parent) {
    report.push({ conversationId, action: "skip", reason: "no top-level history" });
    continue;
  }

  for (const name of readdirSync(sessionDir)) {
    if (!name.endsWith(".jsonl") || name === basename(parent.file)) continue;
    const threadFile = join(sessionDir, name);
    const header = readHeader(threadFile);
    if (!header || header.parentSession) continue;

    const threadTs = name.replace(/\.jsonl$/, "");
    const root = findLogMessageByTs(logFile, threadTs);
    if (!root || root.isBot) continue;
    const parentEntries = buildParentEntriesThroughRoot(parent.messages, root);
    if (parentEntries.length === 0) continue;
    const originalEntries = readEntries(threadFile).filter((entry, index) => index > 0);
    const repairedHeader = {
      ...header,
      id: randomUUID(),
      timestamp: runAt.toISOString(),
      parentSession: parent.file,
      repair: { kind: "orphan-thread-parent", repairedAt: runAt.toISOString() },
    };
    const repaired =
      [repairedHeader, ...parentEntries, ...dropDuplicateRoot(originalEntries, root)]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n";

    if (!dryRun) {
      backupPath(threadFile, rootDataDir, rootBackupDir);
      writeFileSync(threadFile, repaired, { mode: 0o600 });
    }
    report.push({
      conversationId,
      action: dryRun ? "would-repair" : "repaired",
      threadFile,
      parentSession: parent.file,
      insertedEntries: parentEntries.length,
    });
  }
}

console.log(
  JSON.stringify(
    { dryRun, dataDir: rootDataDir, backupDir: dryRun ? null : rootBackupDir, report },
    null,
    2,
  ),
);

function parseArgs(argv) {
  const out = { dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--data-dir") out.dataDir = argv[++i];
    else if (arg === "--conversation") out.conversation = argv[++i];
    else if (arg === "--days") out.days = argv[++i];
    else if (arg === "--max-messages") out.maxMessages = argv[++i];
    else if (arg === "--apply") out.dryRun = false;
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function printUsage() {
  console.log(`Usage: node scripts/repair-orphan-thread-sessions.mjs --data-dir /root/.mom/data [options]

Options:
  --conversation ID     repair one conversation only
  --days N             recent top-level history window (default: 14)
  --max-messages N     cap parent seed messages (default: 200)
  --dry-run            print planned actions only (default)
  --apply              write repaired thread sessions with backups
`);
}

function ensureHistoryParent({ conversationDir, sessionDir, logFile }) {
  const messages = readRecentTopLevelMessages(logFile, historyDays, messageLimit, runAt);
  if (messages.length === 0) return null;
  const currentFile = resolveCurrentSession(sessionDir);
  if (currentFile && isPlatformHistorySession(currentFile)) return { file: currentFile, messages };

  const filename = `${runAt.toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}_history.jsonl`;
  const file = join(sessionDir, filename);
  if (!dryRun) {
    mkdirSync(sessionDir, { recursive: true });
    backupPath(join(sessionDir, "current"), rootDataDir, rootBackupDir);
    writeFileSync(file, buildSessionContent({ conversationDir, messages, runAt, historyDays }), {
      mode: 0o600,
    });
    writeFileSync(join(sessionDir, "current"), filename, { mode: 0o600 });
  }
  return { file, messages };
}

function buildParentEntriesThroughRoot(messages, root) {
  const entries = [];
  for (const message of messages) {
    entries.push(toSessionMessage(message));
    if (message.ts === root.ts) break;
  }
  return entries.at(-1)?.message?.content?.[0]?.text?.includes(String(root.text ?? ""))
    ? entries
    : [];
}

function toSessionMessage(message) {
  return {
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: validIso(message.date) ?? runAt.toISOString(),
    message: buildHistorySessionMessage(message),
  };
}

function dropDuplicateRoot(entries, root) {
  const comparableRoot = comparableUserText(formatHistoryMessage(root));
  const index = entries.findIndex(
    (entry) => comparableUserText(messageText(entry)) === comparableRoot,
  );
  return index === -1 ? entries : entries.filter((_, i) => i !== index);
}

function readEntries(file) {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readHeader(file) {
  return readEntries(file).find((entry) => entry.type === "session") ?? null;
}

function findLogMessageByTs(logFile, ts) {
  return (
    readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .find((entry) => entry.ts === ts) ?? null
  );
}

function readRecentTopLevelMessages(logFile, days, limit, baseTime) {
  const sinceMs = baseTime.getTime() - days * 24 * 60 * 60 * 1000;
  return readFileSync(logFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .filter((entry) => !entry.threadTs && typeof entry.text === "string" && entry.text.trim())
    .filter((entry) => {
      if (!entry.date) return true;
      const ms = new Date(entry.date).getTime();
      return !Number.isFinite(ms) || ms >= sinceMs;
    })
    .slice(-limit);
}

function buildSessionContent({ conversationDir, messages, runAt, historyDays }) {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: runAt.toISOString(),
    cwd: conversationDir,
    source: { kind: "platform-history", file: "log.jsonl", recentDays: historyDays },
  };
  return (
    [header, ...messages.map(toSessionMessage)].map((entry) => JSON.stringify(entry)).join("\n") +
    "\n"
  );
}

function buildHistorySessionMessage(message) {
  const base = {
    role: message.isBot ? "assistant" : "user",
    content: [{ type: "text", text: formatHistoryMessage(message) }],
    ...(message.date ? { timestamp: new Date(message.date).getTime() } : {}),
  };
  if (!message.isBot) return base;
  return {
    ...base,
    api: "platform-history",
    provider: "platform-history",
    model: "platform-history",
    usage: zeroUsage(),
    stopReason: "stop",
  };
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function messageText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text ?? "").join("\n\n");
}

function comparableUserText(text) {
  return String(text)
    .replace(/^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [^\]]+\]\s+(?=\[[^\]]+\]:\s)/, "")
    .trim();
}

function isPlatformHistorySession(file) {
  return readHeader(file)?.source?.kind === "platform-history";
}

function resolveCurrentSession(sessionDir) {
  const pointer = join(sessionDir, "current");
  if (!existsSync(pointer)) return null;
  const name = readFileSync(pointer, "utf-8").trim();
  if (!name) return null;
  const file = join(sessionDir, basename(name));
  return existsSync(file) ? file : null;
}

function formatHistoryMessage(message) {
  const text = String(message.text ?? "").trim();
  if (message.isBot) return text;
  const userLabel = message.userName || message.user || "unknown";
  const timestamp = validIso(message.date) ? formatLocalTimestamp(new Date(message.date)) : null;
  return timestamp ? `[${timestamp}] [${userLabel}]: ${text}` : `[${userLabel}]: ${text}`;
}

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function formatLocalTimestamp(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function listConversations(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function backupPath(path, dataRoot, backupRoot) {
  if (!existsSync(path)) return;
  const relative = path.slice(dataRoot.length).replace(/^\/+/, "");
  const target = join(backupRoot, relative);
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  if (readdirSafe(path)) cpRecursive(path, target);
  else writeFileSync(target, readFileSync(path));
}

function readdirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function cpRecursive(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) cpRecursive(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}

function stamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
