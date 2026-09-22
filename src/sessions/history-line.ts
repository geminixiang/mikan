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

export function formatHistoryLine(options: {
  date?: Date;
  userName?: string;
  threadTs?: string;
  text: string;
}): string {
  const timestamp = options.date ? formatLocalTimestamp(options.date) : null;
  const timestampPart = timestamp ? `[${timestamp}] ` : "";
  const threadPart = options.threadTs ? ` [in-thread:${options.threadTs}]` : "";
  return `${timestampPart}[${options.userName || "unknown"}]${threadPart}: ${options.text}`;
}

const HISTORY_LINE_PREFIX =
  /^\[[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}\]\s+\[[^\]]+\](?:\s+\[in-thread:[^\]]+\])?:\s*/;

export function stripHistoryLinePrefix(text: string): string {
  return text.replace(HISTORY_LINE_PREFIX, "").trim();
}
