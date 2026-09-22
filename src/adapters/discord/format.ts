import {
  extractMarkdownTables,
  normalizeMarkdownTables,
  renderMonospaceTable,
} from "../markdown-tables.js";

const MAX_FENCED_TABLE_WIDTH = 120;

const RULE = "─".repeat(30);

function convertTables(source: string): string {
  const normalized = normalizeMarkdownTables(source);
  const tables = extractMarkdownTables(normalized);
  if (tables.length === 0) return source;

  const lines = normalized.split("\n");
  const out: string[] = [];
  let cursor = 0;

  for (const table of tables) {
    out.push(...lines.slice(cursor, table.startLine));
    const rendered = renderMonospaceTable(table);
    if (
      rendered.split("\n").reduce((max, line) => Math.max(max, line.length), 0) >
      MAX_FENCED_TABLE_WIDTH
    ) {
      out.push(...lines.slice(table.startLine, table.endLine));
    } else {
      out.push("```", rendered, "```");
    }
    cursor = table.endLine;
  }
  out.push(...lines.slice(cursor));

  return out.join("\n");
}

function convertUnsupportedSyntax(source: string): string {
  let inFence = false;
  return source
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return RULE;

      return line.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) =>
        alt.trim() ? `${alt}\n${url}` : url,
      );
    })
    .join("\n");
}

export function formatDiscordMarkdown(source: string): string {
  return convertUnsupportedSyntax(convertTables(source));
}
