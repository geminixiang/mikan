import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { KnownBlock } from "@slack/types";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const MAX_BLOCKS = 50;
const SECTION_TEXT_LIMIT = 3000;
const FIELD_TEXT_LIMIT = 2000;

function pushSection(blocks: KnownBlock[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  for (let i = 0; i < trimmed.length && blocks.length < MAX_BLOCKS; i += SECTION_TEXT_LIMIT) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: trimmed.slice(i, i + SECTION_TEXT_LIMIT) },
    } as KnownBlock);
  }
}

function renderInline(tokens: Token[] | null | undefined): string {
  if (!tokens) return "";
  let text = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const linkText = tokens[i + 1];
    const linkClose = tokens[i + 2];
    if (
      token.type === "link_open" &&
      token.markup === "autolink" &&
      linkText?.type === "text" &&
      linkText.content.includes("|") &&
      linkClose?.type === "link_close"
    ) {
      text += `<${linkText.content}>`;
      i += 2;
    } else if (token.type === "text" || token.type === "code_inline") text += token.content;
    else if (token.type === "softbreak" || token.type === "hardbreak") text += "\n";
    else if (token.type === "strong_open") text += "*";
    else if (token.type === "strong_close") text += "*";
    else if (token.type === "em_open") text += "_";
    else if (token.type === "em_close") text += "_";
    else if (token.type === "link_open") {
      const href = token.attrGet("href");
      if (href) text += `<${href}|`;
    } else if (token.type === "link_close") {
      text += ">";
    } else if (token.children) {
      text += renderInline(token.children);
    }
  }
  return text;
}

function collectInlineUntil(
  tokens: Token[],
  index: number,
  endType: string,
): { text: string; next: number } {
  let text = "";
  let i = index;
  for (; i < tokens.length && tokens[i].type !== endType; i++) {
    const token = tokens[i];
    if (token.type === "inline") text += renderInline(token.children) || token.content;
    else if (token.type === "fence" || token.type === "code_block")
      text += `\n\`\`\`\n${token.content}\n\`\`\``;
  }
  return { text, next: i };
}

function isTableAt(tokens: Token[], index: number): boolean {
  return tokens[index]?.type === "table_open";
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

function parseTable(
  tokens: Token[],
  index: number,
): { blocks: KnownBlock[]; fallback: string; next: number } | null {
  if (!isTableAt(tokens, index)) return null;

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
      currentRow.push(renderInline(token.children) || token.content);
    }
  }

  if (!headers.length || !rows.length) return null;

  const fallback = [headers.join(" | "), ...rows.map((row) => row.join(" | "))].join("\n");
  return { blocks: [buildTableBlock(headers, rows)], fallback, next: i };
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

export function renderSlackBlocks(source: string): { text: string; blocks: KnownBlock[] } {
  const tokens = markdown.parse(normalizeMarkdownTables(source), {});
  const blocks: KnownBlock[] = [];
  const fallback: string[] = [];

  for (let i = 0; i < tokens.length && blocks.length < MAX_BLOCKS; i++) {
    const token = tokens[i];

    const table = parseTable(tokens, i);
    if (table) {
      blocks.push(...table.blocks.slice(0, MAX_BLOCKS - blocks.length));
      fallback.push(table.fallback);
      i = table.next;
      continue;
    }

    if (token.type === "heading_open") {
      const collected = collectInlineUntil(tokens, i + 1, "heading_close");
      const text = `*${collected.text}*`;
      pushSection(blocks, text);
      fallback.push(collected.text);
      i = collected.next;
      continue;
    }

    if (token.type === "paragraph_open") {
      const collected = collectInlineUntil(tokens, i + 1, "paragraph_close");
      pushSection(blocks, collected.text);
      fallback.push(collected.text);
      i = collected.next;
      continue;
    }

    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const lines: string[] = [];
      let item = 1;
      for (i += 1; i < tokens.length && !tokens[i].type.endsWith("list_close"); i++) {
        if (tokens[i].type !== "inline") continue;
        const marker = token.type === "ordered_list_open" ? `${item++}.` : "•";
        lines.push(`${marker} ${renderInline(tokens[i].children) || tokens[i].content}`);
      }
      const text = lines.join("\n");
      pushSection(blocks, text);
      fallback.push(text);
      continue;
    }

    if (token.type === "fence" || token.type === "code_block") {
      const text = `\`\`\`\n${token.content}\n\`\`\``;
      pushSection(blocks, text);
      fallback.push(token.content);
    }
  }

  if (!blocks.length) pushSection(blocks, source);
  return { text: fallback.join("\n\n") || source, blocks };
}
