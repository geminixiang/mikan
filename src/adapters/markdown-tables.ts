import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { MarkdownTable } from "./types.js";

const markdown = new MarkdownIt({ html: false });

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

  if (!headers.length || !rows.length) return null;

  return {
    table: { headers, rows, startLine: open.map[0], endLine: tokens[i]?.map?.[1] ?? open.map[1] },
    next: i,
  };
}

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

export function renderMonospaceTable(table: MarkdownTable): string {
  const columns = table.headers.length;
  const rows = table.rows.map((row) =>
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
