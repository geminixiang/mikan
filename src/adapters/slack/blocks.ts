import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { KnownBlock } from "@slack/types";

// Parser is used only to locate tables and derive plain-text fallback.
// Prose is never re-serialized from tokens: it is sliced verbatim from the
// source and handed to Slack as a native `markdown` block, so Slack owns
// all prose rendering (same renderer as the markdown_text streaming API).
const markdown = new MarkdownIt({ html: false });

const MAX_BLOCKS = 50;
// Slack rejects messages whose markdown block text exceeds 12k (msg_too_long).
const MARKDOWN_TEXT_LIMIT = 12000;
const FIELD_TEXT_LIMIT = 2000;

// Legacy Slack-style links (<url|label>) predate the standard-GFM response
// source contract; system producers may still emit them.
const LEGACY_MRKDWN_LINK_PATTERN = /<(https?:\/\/[^<>|\s]+)\|([^<>\n]+)>/g;

function convertLegacyMrkdwnLinks(source: string): string {
  return source.replace(LEGACY_MRKDWN_LINK_PATTERN, "[$2]($1)");
}

// Slack user/bot-user ids: U/W prefix. Already-native mentions pass through.
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;
const MENTION_PATTERN = /<@([^<>\n]+)>/g;

/**
 * Resolve response-source mentions to Slack's native form.
 *
 * The response source is platform-neutral: the model writes `<@userName>`
 * from the prompt's Users table, and the adapter owns the conversion to
 * `<@U…>` — Slack only links and notifies on the raw user id. Lookup covers
 * userName and displayName case-insensitively; native-id mentions pass
 * through, and unknown names stay verbatim rather than guessing.
 */
export function resolveSlackMentions(
  source: string,
  users: Iterable<{ id: string; userName: string; displayName: string }>,
): string {
  if (!source.includes("<@")) return source;
  const list = [...users];
  const byName = new Map<string, string>();
  for (const user of list) {
    if (user.userName) byName.set(user.userName.toLowerCase(), user.id);
  }
  // Display names never shadow a userName held by someone else.
  for (const user of list) {
    const display = user.displayName?.toLowerCase();
    if (display && !byName.has(display)) byName.set(display, user.id);
  }
  return source.replace(MENTION_PATTERN, (mention, name: string) => {
    if (SLACK_USER_ID_PATTERN.test(name)) return mention;
    const id = byName.get(name.trim().replace(/^@/, "").toLowerCase());
    return id ? `<@${id}>` : mention;
  });
}

function normalizeMarkdownTables(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return line;
      if (!/^[|+\-:\s]+$/.test(trimmed) || !trimmed.includes("+")) return line;
      return line.replaceAll("+", "|");
    })
    .join("\n");
}

function inlinePlainText(tokens: Token[] | null | undefined): string {
  if (!tokens) return "";
  let text = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") text += token.content;
    else if (token.type === "softbreak" || token.type === "hardbreak") text += "\n";
    else if (token.children) text += inlinePlainText(token.children);
  }
  return text;
}

function buildTableBlock(headers: string[], rows: string[][]): KnownBlock {
  const hasIndex = headers[0] === "#";
  const tableHeaders = hasIndex ? headers : ["#", ...headers];
  const tableRows = hasIndex
    ? rows
    : rows.map((row, rowNumber) => [String(rowNumber + 1)].concat(row));
  return {
    type: "table",
    rows: [tableHeaders, ...tableRows].map((row) =>
      row.map((cell) => ({ type: "raw_text", text: (cell || " ").slice(0, FIELD_TEXT_LIMIT) })),
    ),
    column_settings: tableHeaders.map(() => ({ is_wrapped: true })),
  } as KnownBlock;
}

interface ParsedTable {
  block: KnownBlock;
  fallback: string;
  startLine: number;
  endLine: number;
}

function parseTable(tokens: Token[], index: number): { table: ParsedTable; next: number } | null {
  const open = tokens[index];
  if (open?.type !== "table_open" || !open.map) return null;

  const headers: string[] = [];
  const rows: string[][] = [];
  let currentRow: string[] | null = null;
  let inHead = false;
  let i = index + 1;

  for (; i < tokens.length && tokens[i].type !== "table_close"; i++) {
    const token = tokens[i];
    if (token.type === "thead_open") inHead = true;
    else if (token.type === "thead_close") inHead = false;
    else if (token.type === "tr_open") currentRow = [];
    else if (token.type === "tr_close" && currentRow) {
      if (inHead) headers.push(...currentRow);
      else rows.push(currentRow);
      currentRow = null;
    } else if (token.type === "inline" && currentRow) {
      currentRow.push(inlinePlainText(token.children) || token.content);
    }
  }

  if (!headers.length || !rows.length) return null;

  const fallback = [headers.join(" | "), ...rows.map((row) => row.join(" | "))].join("\n");
  const endLine = tokens[i]?.map?.[1] ?? open.map[1];
  return {
    table: {
      block: buildTableBlock(headers, rows),
      fallback,
      startLine: open.map[0],
      endLine,
    },
    next: i,
  };
}

/** Split prose into chunks under the markdown block limit, preferring
 *  paragraph boundaries, then line boundaries, then a hard slice. */
function splitProse(text: string): string[] {
  if (text.length <= MARKDOWN_TEXT_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MARKDOWN_TEXT_LIMIT) {
    const window = rest.slice(0, MARKDOWN_TEXT_LIMIT);
    let cut = window.lastIndexOf("\n\n");
    if (cut <= 0) cut = window.lastIndexOf("\n");
    if (cut <= 0) cut = MARKDOWN_TEXT_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

function pushMarkdown(blocks: KnownBlock[], prose: string): void {
  const trimmed = prose.trim();
  if (!trimmed) return;
  for (const chunk of splitProse(trimmed)) {
    if (blocks.length >= MAX_BLOCKS) return;
    const text = chunk.trim();
    if (text) blocks.push({ type: "markdown", text } as KnownBlock);
  }
}

function plainTextFallback(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.type === "inline") parts.push(inlinePlainText(token.children) || token.content);
    else if (token.type === "fence" || token.type === "code_block")
      parts.push(token.content.trimEnd());
  }
  return parts.filter(Boolean).join("\n");
}

export function renderSlackBlocks(source: string): { text: string; blocks: KnownBlock[] } {
  const normalized = normalizeMarkdownTables(convertLegacyMrkdwnLinks(source));
  const tokens = markdown.parse(normalized, {});
  const lines = normalized.split("\n");

  const tables: ParsedTable[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseTable(tokens, i);
    if (parsed) {
      tables.push(parsed.table);
      i = parsed.next;
    }
  }

  const blocks: KnownBlock[] = [];
  const fallback: string[] = [];
  let cursor = 0;
  for (const table of tables) {
    const prose = lines.slice(cursor, table.startLine).join("\n");
    pushMarkdown(blocks, prose);
    if (prose.trim()) fallback.push(plainTextFallback(markdown.parse(prose, {})));
    if (blocks.length < MAX_BLOCKS) {
      blocks.push(table.block);
      fallback.push(table.fallback);
    }
    cursor = table.endLine;
  }
  const trailingProse = lines.slice(cursor).join("\n");
  pushMarkdown(blocks, trailingProse);
  if (trailingProse.trim()) fallback.push(plainTextFallback(markdown.parse(trailingProse, {})));

  return {
    text: fallback.filter(Boolean).join("\n\n") || normalized,
    blocks,
  };
}
