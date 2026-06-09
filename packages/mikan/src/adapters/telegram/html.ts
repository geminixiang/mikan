function htmlTableToText(tableHtml: string): string {
  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return "";

  const numCols = Math.max(...rows.map((r) => r.length));
  const colWidths: number[] = Array(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], (row[i] ?? "").length);
    }
  }

  const sep = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const lines: string[] = [sep];
  for (let i = 0; i < rows.length; i++) {
    const cells = colWidths.map((w, j) => ` ${(rows[i][j] ?? "").padEnd(w)} `);
    lines.push("|" + cells.join("|") + "|");
    if (i === 0) lines.push(sep);
  }
  lines.push(sep);
  return lines.join("\n");
}

const SIMPLE_TAG_ALIASES: Record<string, string> = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
  "tg-spoiler": "tg-spoiler",
};

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTelegramAttribute(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

function sanitizeTelegramTag(tag: string): string {
  const trimmed = tag.trim();

  if (/^<br\s*\/?>$/i.test(trimmed)) return "\n";
  if (/^<(p|div)\s*>$/i.test(trimmed)) return "";
  if (/^<\/(p|div)\s*>$/i.test(trimmed)) return "\n";

  const match = trimmed.match(/^<\s*(\/?)\s*([a-z0-9-]+)([^>]*)>$/i);
  if (!match) return escapeTelegramHtml(tag);

  const [, closing, rawName, rawAttrs] = match;
  const name = rawName.toLowerCase();
  const aliasedName = SIMPLE_TAG_ALIASES[name];

  if (aliasedName) {
    return `<${closing}${aliasedName}>`;
  }

  if (name === "a") {
    if (closing) return "</a>";
    const hrefMatch = rawAttrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!hrefMatch) return escapeTelegramHtml(tag);
    return `<a href="${escapeTelegramAttribute(hrefMatch[2])}">`;
  }

  return escapeTelegramHtml(tag);
}

export function sanitizeTelegramHtml(text: string): string {
  const withAsciiTables = text.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const ascii = htmlTableToText(tableHtml);
    return ascii ? `<pre>${ascii}</pre>` : "";
  });

  return withAsciiTables
    .split(/(<[^>]+>)/g)
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith("<") && segment.endsWith(">")) {
        return sanitizeTelegramTag(segment);
      }
      return escapeTelegramHtml(segment);
    })
    .join("");
}
