import { recordDiagnosticEvent } from "../../observability/index.js";
import type { KnownBlock } from "@slack/types";

const pending = new WeakMap<object, Map<string, { at: number; attempts: number }>>();
const MAX_PENDING = 128;
const RETENTION_MS = 10 * 60_000;
const ERROR_CODES = new Set([
  "block_mismatch",
  "invalid_blocks",
  "msg_too_long",
  "ratelimited",
  "rate_limited",
]);
const BLOCK_TYPES = new Set([
  "markdown",
  "table",
  "section",
  "context",
  "divider",
  "actions",
  "rich_text",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function syntax(source: string) {
  const trimmed = source.trimStart();
  const fences = source.split("\n").filter((line) => /^\s*(`{3,}|~{3,})/.test(line));
  return {
    leadingConstruct: /^(?:`{3,}|~{3,})/.test(trimmed)
      ? "fence"
      : trimmed.startsWith("|")
        ? "table_like"
        : /^#{1,6}(?:\s|$)/.test(trimmed)
          ? "heading"
          : /^[*_-]/.test(trimmed)
            ? "list_or_emphasis"
            : /^[[<]/.test(trimmed)
              ? "link_like"
              : "other",
    fenceLineCount: fences.length,
    fenceWithWorkingSuffix: fences.some((line) => /^\s*(?:`{3,}|~{3,}) +\.\.\.\s*$/.test(line)),
  };
}

function shape(source: string, payload: { text: string; blocks: KnownBlock[] }) {
  return {
    sourceLength: source.length,
    fallbackLength: payload.text.length,
    blockCount: payload.blocks.length,
    ...syntax(source),
    blockTypes: payload.blocks
      .slice(0, 50)
      .map((block) => (BLOCK_TYPES.has(block.type) ? block.type : "other")),
    markdownLengths: payload.blocks
      .filter((block) => block.type === "markdown")
      .slice(0, 50)
      .map((block) => block.text.length),
    tableRows: payload.blocks
      .filter((block) => block.type === "table")
      .slice(0, 50)
      .map((block) => block.rows.length),
    tableMaxColumns: payload.blocks
      .filter((block) => block.type === "table")
      .slice(0, 50)
      .map((block) => Math.max(0, ...block.rows.map((row) => row.length))),
  };
}

function validation(error: unknown) {
  const data = record(record(error).data);
  const messages = record(data.response_metadata).messages;
  const details = Array.isArray(messages)
    ? messages.slice(0, 10).filter((item): item is string => typeof item === "string")
    : [];
  return {
    errorCode: typeof data.error === "string" && ERROR_CODES.has(data.error) ? data.error : "other",
    validationCount: Array.isArray(messages) ? messages.length : 0,
    validationCategories: details.map((message) =>
      /must be less than|maximum|too long/i.test(message)
        ? "limit"
        : /missing|required/i.test(message)
          ? "required"
          : /invalid|unsupported|not allowed/i.test(message)
            ? "invalid"
            : "other",
    ),
    blockIndices: details
      .flatMap((message) =>
        [...message.matchAll(/\/blocks\/(\d{1,3})(?=\/|\]|\s|$)/g)]
          .slice(0, 10)
          .map((match) => Number(match[1])),
      )
      .slice(0, 10),
  };
}

export function recordSlackUpdate(
  owner: object,
  target: { channel: string; ts: string },
  source: string,
  payload: { text: string; blocks: KnownBlock[] },
  outcome: { error: unknown } | { success: true },
): void {
  try {
    const { channel, ts } = target;
    const now = Date.now();
    let failures = pending.get(owner);
    if (failures)
      for (const [key, value] of failures) {
        if (now - value.at >= RETENTION_MS) failures.delete(key);
      }
    const key = `${channel}:${ts}`;
    const previous = failures?.get(key);
    if ("success" in outcome && !previous) return;
    const attempts = (previous?.attempts ?? 0) + ("error" in outcome ? 1 : 0);
    if ("error" in outcome) {
      if (!failures) {
        failures = new Map();
        pending.set(owner, failures);
      }
      failures.delete(key);
      failures.set(key, { at: now, attempts });
      if (failures.size > MAX_PENDING) failures.delete(failures.keys().next().value!);
    } else {
      failures?.delete(key);
    }
    recordDiagnosticEvent("error" in outcome ? "slack.update.rejected" : "slack.update.recovered", {
      operation: "chat.update",
      channelId: channel,
      responseMessageId: ts,
      failedAttempts: attempts,
      ...shape(source, payload),
      ...("error" in outcome ? validation(outcome.error) : {}),
    });
  } catch {}
}
