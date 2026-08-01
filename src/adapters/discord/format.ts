import {
  extractMarkdownTables,
  normalizeMarkdownTables,
  renderMonospaceTable,
} from "../markdown-tables.js";

/**
 * Discord-side presentation of a response.
 *
 * The model writes standard markdown for every platform; making it write
 * Discord-flavoured markdown instead would trade one platform's rendering for
 * another's, and Discord is the one that renders the least. So the conversion
 * belongs here, at the last step before sending.
 *
 * Today that means tables. Discord renders every other construct we emit —
 * headers, lists, quotes, code, links, spoilers — but has no table support at
 * all, so a table arrives as a wall of literal pipes and dashes. Alignment
 * inside a code fence is the only thing Discord will lay out in columns.
 */

/** Fence tables at this width or less; wider ones wrap and look worse aligned. */
const MAX_FENCED_TABLE_WIDTH = 120;

function longestLine(text: string): number {
  return text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

/**
 * Replace GFM tables with aligned, fenced equivalents.
 *
 * Prose is sliced verbatim around each table rather than re-serialized, so
 * everything Discord already renders correctly passes through untouched.
 */
export function formatDiscordMarkdown(source: string): string {
  const normalized = normalizeMarkdownTables(source);
  const tables = extractMarkdownTables(normalized);
  if (tables.length === 0) return source;

  const lines = normalized.split("\n");
  const out: string[] = [];
  let cursor = 0;

  for (const table of tables) {
    out.push(...lines.slice(cursor, table.startLine));
    const rendered = renderMonospaceTable(table);
    // Too wide to align: Discord soft-wraps inside a fence and the columns
    // scatter, which is worse than the pipes. Leave those as they came.
    if (longestLine(rendered) > MAX_FENCED_TABLE_WIDTH) {
      out.push(...lines.slice(table.startLine, table.endLine));
    } else {
      out.push("```", rendered, "```");
    }
    cursor = table.endLine;
  }
  out.push(...lines.slice(cursor));

  return out.join("\n");
}
