import { isRecord, parseJsonValue, readTextFileIfExists } from "../utils/file-guards.js";

/**
 * Biweekly rotation clock for top-level shared sessions: a session file
 * rotates when its header timestamp falls in a different two-week bucket
 * (anchored to a fixed Sunday) than the given "now".
 */

const BIWEEKLY_ROTATION_ANCHOR = new Date(2026, 0, 4); // Sunday
const BIWEEKLY_MS = 14 * 24 * 60 * 60 * 1000;

export function shouldRotateTopLevelSession(sessionFile: string, now: Date): boolean {
  const timestamp = readSessionTimestamp(sessionFile);
  return timestamp !== null && biweeklyBucket(timestamp) !== biweeklyBucket(now);
}

function readSessionTimestamp(sessionFile: string): Date | null {
  const raw = readTextFileIfExists(sessionFile);
  if (raw === undefined) return null;
  const firstLine = raw.split("\n").find((line) => line.trim());
  if (!firstLine) return null;
  try {
    const header = parseJsonValue(
      firstLine,
      (value): value is { timestamp?: unknown } => isRecord(value),
      (detail) => (detail === "unexpected JSON shape" ? "expected a JSON object" : detail),
    );
    if (typeof header.timestamp !== "string") return null;
    const date = new Date(header.timestamp);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

function biweeklyBucket(date: Date): number {
  const weekStart = sundayStart(date).getTime();
  const anchor = sundayStart(BIWEEKLY_ROTATION_ANCHOR).getTime();
  return Math.floor((weekStart - anchor) / BIWEEKLY_MS);
}

function sundayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
}
