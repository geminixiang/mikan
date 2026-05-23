#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.dataDir || args.help) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const dataDir = resolve(args.dataDir);
const recentDays = Number(args.days ?? 14);
const maxMessages = Number(args.maxMessages ?? 200);
const dryRun = args.dryRun !== false;
const conversationIds = args.conversation
  ? [String(args.conversation)]
  : listConversations(dataDir);
const migrationTime = new Date();
const backupDir = join(dataDir, `.migration-backup-${stamp(migrationTime)}-session-history`);
const report = [];

for (const conversationId of conversationIds) {
  const conversationDir = join(dataDir, conversationId);
  const logFile = join(conversationDir, "log.jsonl");
  if (!existsSync(logFile)) continue;

  const sessionDir = join(conversationDir, "sessions");
  const messages = readRecentTopLevelMessages(logFile, recentDays, maxMessages, migrationTime);
  if (messages.length === 0) {
    report.push({ conversationId, action: "skip", reason: "no recent top-level log messages" });
    continue;
  }

  const currentFile = resolveCurrentSession(sessionDir);
  const shouldMaterialize = !currentFile || args.force === true;
  if (!shouldMaterialize) {
    report.push({ conversationId, action: "skip", reason: "sessions/current exists", currentFile });
    continue;
  }

  const filename = `${migrationTime.toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}_history.jsonl`;
  const sessionFile = join(sessionDir, filename);
  const content = buildSessionContent({
    conversationDir,
    messages,
    sessionTime: migrationTime,
    historyWindowDays: recentDays,
  });

  if (!dryRun) {
    mkdirSync(sessionDir, { recursive: true });
    backupPath(join(conversationDir, "sessions"), dataDir, backupDir);
    writeFileSync(sessionFile, content, { mode: 0o600 });
    writeFileSync(join(sessionDir, "current"), filename, { mode: 0o600 });
  }

  report.push({
    conversationId,
    action: dryRun ? "would-materialize" : "materialized",
    sessionFile,
    messages: messages.length,
    latestTs: messages.at(-1)?.ts,
  });
}

console.log(
  JSON.stringify({ dryRun, dataDir, backupDir: dryRun ? null : backupDir, report }, null, 2),
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
    else if (arg === "--force") out.force = true;
    else if (arg === "--apply") out.dryRun = false;
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function printUsage() {
  console.log(`Usage: node scripts/migrate-session-history.mjs --data-dir /root/.mom/data [options]

Options:
  --conversation ID     migrate one conversation only
  --days N             recent top-level history window (default: 14)
  --max-messages N     cap session seed messages (default: 200)
  --force              rebuild even when sessions/current exists
  --dry-run            print planned actions only (default)
  --apply              write files and backup existing sessions dirs
`);
}

function listConversations(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function resolveCurrentSession(sessionDir) {
  const pointer = join(sessionDir, "current");
  if (!existsSync(pointer)) return null;
  const name = readFileSync(pointer, "utf-8").trim();
  if (!name) return null;
  const file = join(sessionDir, basename(name));
  return existsSync(file) ? file : null;
}

function readRecentTopLevelMessages(logFile, days, limit, baseTime) {
  const sinceMs = baseTime.getTime() - days * 24 * 60 * 60 * 1000;
  const rows = readFileSync(logFile, "utf-8")
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
    });
  return rows.slice(-limit);
}

function buildSessionContent({ conversationDir, messages, sessionTime, historyWindowDays }) {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: sessionTime.toISOString(),
    cwd: conversationDir,
    source: { kind: "platform-history", file: "log.jsonl", recentDays: historyWindowDays },
  };
  const entries = messages.map((message) => ({
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: null,
    timestamp: validIso(message.date) ?? sessionTime.toISOString(),
    message: buildHistorySessionMessage(message),
  }));
  return [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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

function formatHistoryMessage(message) {
  const text = String(message.text ?? "").trim();
  if (message.isBot) return text;
  const userLabel = message.userName || message.user || "unknown";
  const timestamp = validIso(message.date) ? formatLocalTimestamp(new Date(message.date)) : null;
  return timestamp ? `[${timestamp}] [${userLabel}]: ${text}` : `[${userLabel}]: ${text}`;
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

function backupPath(path, rootDir, backupRoot) {
  if (!existsSync(path)) return;
  const relative = path.slice(rootDir.length).replace(/^\/+/, "");
  const target = join(backupRoot, relative);
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpRecursive(path, target);
}

function cpRecursive(src, dest) {
  const stat = readdirSync(src, { withFileTypes: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of stat) {
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
