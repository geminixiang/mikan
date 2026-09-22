import MarkdownIt from "markdown-it";
import { normalizeSlackCurrencyBold } from "./markdown.js";
import type Token from "markdown-it/lib/token.mjs";
import type { KnownBlock } from "@slack/types";
import {
  extractMarkdownTables,
  inlinePlainText,
  normalizeMarkdownTables,
} from "../markdown-tables.js";

const markdown = new MarkdownIt({ html: false });

const MAX_BLOCKS = 50;
const MARKDOWN_TEXT_LIMIT = 12000;
const FIELD_TEXT_LIMIT = 2000;

const LEGACY_MRKDWN_LINK_PATTERN = /<(https?:\/\/[^<>|\s]+)\|([^<>\n]+)>/g;

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;
const MENTION_PATTERN = /<@([^<>\n]+)>/g;

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
  const normalized = normalizeMarkdownTables(
    normalizeSlackCurrencyBold(source.replace(LEGACY_MRKDWN_LINK_PATTERN, "[$2]($1)")),
  );
  const lines = normalized.split("\n");

  const tables = extractMarkdownTables(normalized);

  const blocks: KnownBlock[] = [];
  const fallback: string[] = [];
  let cursor = 0;
  for (const table of tables) {
    const prose = lines.slice(cursor, table.startLine).join("\n");
    pushMarkdown(blocks, prose);
    if (prose.trim()) fallback.push(plainTextFallback(markdown.parse(prose, {})));
    if (blocks.length < MAX_BLOCKS) {
      blocks.push(buildTableBlock(table.headers, table.rows));
      fallback.push(
        [table.headers.join(" | "), ...table.rows.map((row) => row.join(" | "))].join("\n"),
      );
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
