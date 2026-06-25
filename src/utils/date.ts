/**
 * Format a Date as a local-timezone timestamp string: YYYY-MM-DD HH:MM:SS±HH:MM
 * Returns null when the date is invalid (non-finite time value).
 *
 * This format is used both when writing user messages (agent.ts) and when
 * reading history back into sessions (agent-memory-file-manager.ts). Keeping it
 * in one place ensures normalizeComparableText's regex stays valid.
 */
export function formatLocalTimestamp(date: Date): string | null {
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;

  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
