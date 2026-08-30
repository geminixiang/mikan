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
 * Discord renders most of what we emit — headings, lists, quotes, fenced code
 * with highlighting, links, spoilers, and its own `-#` subtext. What it does
 * not render is handled below, each verified against the real client rather
 * than against the docs.
 */

/** Fence tables at this width or less; wider ones wrap and look worse aligned. */
const MAX_FENCED_TABLE_WIDTH = 120;

/** Stand-in for a horizontal rule, which Discord has no syntax for. */
const RULE = "─".repeat(30);

/**
 * Replace GFM tables with aligned, fenced equivalents.
 *
 * Prose is sliced verbatim around each table rather than re-serialized, so
 * everything Discord already renders correctly passes through untouched.
 */
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
    // Too wide to align: Discord soft-wraps inside a fence and the columns
    // scatter, which is worse than the pipes. Leave those as they came.
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

/**
 * Line-level rewrites for constructs Discord ignores, applied outside fenced
 * code so a code sample keeps whatever it contains.
 *
 * Runs after table conversion because that step maps source line numbers, and
 * a rewrite that changed the line count first would misplace every table.
 */
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

      // A horizontal rule renders as its own literal dashes. Discord has no
      // rule syntax, so draw one — dropping the line would lose the section
      // break the author meant.
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return RULE;

      // Discord does not render markdown images: `![alt](url)` arrives as a
      // stray "!" followed by a link, and the image never appears. A bare URL
      // *does* auto-embed, so emit that and keep the alt text above it.
      return line.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt: string, url: string) =>
        alt.trim() ? `${alt}\n${url}` : url,
      );
    })
    .join("\n");
}

/** Everything Discord cannot render, converted to something it can. */
export function formatDiscordMarkdown(source: string): string {
  return convertUnsupportedSyntax(convertTables(source));
}
