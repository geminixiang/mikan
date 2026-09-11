import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { MarkdownTable } from "./types.js";

export type { MarkdownTable } from "./types.js";

/**
 * Locating GFM tables in a response, as plain data.
 *
 * Every platform needs the same thing from a markdown table and renders it
 * differently: Slack has a native table block, Discord has no table support at
 * all and needs monospace alignment. Only the *finding* is common, so that is
 * what lives here — callers keep their own rendering, and neither has to carry
 * a second markdown parser to get at the cells.
 *
 * Prose is deliberately not re-serialized from tokens anywhere: callers slice
 * it verbatim from the source using the line span reported here, so the
 * platform's own renderer stays responsible for everything that is not a table.
 */

const markdown = new MarkdownIt({ html: false });

/**
 * Models sometimes draw the separator row in ASCII-art style (`+---+---+`),
 * which GFM does not recognise. Rewriting those pluses is enough to make the
 * table parse; every other line is left exactly as written.
 */
export function normalizeMarkdownTables(source: string): string {
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

export function inlinePlainText(tokens: Token[] | null | undefined): string {
  if (!tokens) return "";
  let text = "";
  for (const token of tokens) {
    if (token.type === "text" || token.type === "code_inline") text += token.content;
    else if (token.type === "softbreak" || token.type === "hardbreak") text += "\n";
    else if (token.children) text += inlinePlainText(token.children);
  }
  return text;
}

function parseOne(tokens: Token[], index: number): { table: MarkdownTable; next: number } | null {
  const open = tokens[index];
  if (open?.type !== "table_open" || !open.map) return null;

  const headers: string[] = [];
  const rows: string[][] = [];
  let currentRow: string[] | null = null;
  let inHead = false;
  let i = index + 1;

  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.type === "table_close") break;
    switch (token.type) {
      case "thead_open":
        inHead = true;
        break;
      case "thead_close":
        inHead = false;
        break;
      case "tr_open":
        currentRow = [];
        break;
      case "tr_close":
        if (!currentRow) break;
        if (inHead) headers.push(...currentRow);
        else rows.push(currentRow);
        currentRow = null;
        break;
      case "inline":
        currentRow?.push(inlinePlainText(token.children) || token.content);
        break;
    }
  }

  // A header with no body is not a table anyone wants rendered as one.
  if (!headers.length || !rows.length) return null;

  return {
    table: { headers, rows, startLine: open.map[0], endLine: tokens[i]?.map?.[1] ?? open.map[1] },
    next: i,
  };
}

/** Every table in `source`, in document order, with its line span. */
export function extractMarkdownTables(source: string): MarkdownTable[] {
  const tokens = markdown.parse(normalizeMarkdownTables(source), {});
  const tables: MarkdownTable[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const found = parseOne(tokens, index);
    if (!found) continue;
    tables.push(found.table);
    index = found.next;
  }
  return tables;
}

/**
 * Display width in monospace cells, by the East Asian Width convention.
 *
 * Padding by code-point count misaligns a Chinese table so badly that the
 * result reads worse than the raw pipes it replaced, so this is a large
 * improvement — but it is an approximation, not a guarantee. Verified against
 * Discord's rendering: its code-block CJK fallback font is *not* exactly twice
 * the Latin advance, so a column mixing `USB-C Hub` with `無線藍牙耳機` still
 * ends up a little ragged. No amount of space padding fixes that, because the
 * ratio is not an integer; the only exact answers are giving up columns for
 * CJK tables entirely, and that trade was considered and declined — close
 * alignment reads better than no table.
 */
// Fixed ranges preserve our width approximation (not all Unicode emoji are wide).
// Hangul, CJK/Yi, compatibility/full-width forms, emoji, and wide dingbats.
const WIDE_CHARACTER =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u2705\u270a-\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf]/u;

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDE_CHARACTER.test(char) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Render a table as aligned monospace rows, for a platform with no table
 * support of its own. The caller decides whether to fence it.
 */
export function renderMonospaceTable(table: MarkdownTable): string {
  const columns = table.headers.length;
  const rows = table.rows.map((row) =>
    // Ragged rows are common in generated markdown; pad rather than drop them.
    Array.from({ length: columns }, (_, index) => row[index] ?? ""),
  );
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(
      displayWidth(table.headers[index] ?? ""),
      ...rows.map((row) => displayWidth(row[index] ?? "")),
    ),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => pad(cell, widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    line(table.headers),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
}
