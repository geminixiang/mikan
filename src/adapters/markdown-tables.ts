import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

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

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  /** Source line span, so a caller can slice the prose around it. */
  startLine: number;
  endLine: number;
}

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
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals … Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
      (code >= 0xff00 && code <= 0xff60) || // full-width forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) || // emoji
      // Wide symbols scattered through Miscellaneous Symbols and Dingbats.
      // ✅ and ❌ carry most verdict columns a model writes, so getting these
      // wrong drifts the alignment of exactly the tables this exists for.
      code === 0x2705 ||
      (code >= 0x270a && code <= 0x270b) ||
      code === 0x2728 ||
      code === 0x274c ||
      code === 0x274e ||
      (code >= 0x2753 && code <= 0x2755) ||
      code === 0x2757 ||
      (code >= 0x2795 && code <= 0x2797) ||
      code === 0x27b0 ||
      code === 0x27bf;
    width += wide ? 2 : 1;
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
