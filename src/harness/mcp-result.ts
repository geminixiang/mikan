import { randomBytes } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolResult,
  type Context,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { redactSecrets } from "./tools/secret-redaction.js";

export interface McpTextLimits {
  maxBytes: number;
  maxLines: number;
}

export interface BoundedMcpText {
  text: string;
  truncated: boolean;
  digest?: true;
}

export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

const SPILL_DIR = [".mikan", "mcp-output"];
const NOTICE_RESERVE_BYTES = 640;
const NOTICE_RESERVE_LINES = 4;
const RESULT_LIMITS: McpTextLimits = {
  maxBytes: DEFAULT_MAX_BYTES - NOTICE_RESERVE_BYTES,
  maxLines: DEFAULT_MAX_LINES - NOTICE_RESERVE_LINES,
};

interface DigestLevel {
  stringChars: number;
  arrayItems: number;
  depth: number;
}

const DIGEST_LEVELS: readonly DigestLevel[] = [
  { stringChars: 200, arrayItems: 3, depth: 6 },
  { stringChars: 80, arrayItems: 2, depth: 4 },
  { stringChars: 40, arrayItems: 1, depth: 3 },
  { stringChars: 16, arrayItems: 1, depth: 2 },
];

type RawBlock = Record<string, unknown>;

function isRecord(value: unknown): value is RawBlock {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(block: RawBlock, key: string): string | undefined {
  const value = block[key];
  return typeof value === "string" ? value : undefined;
}

function describeResource(resource: RawBlock): string {
  const uri = stringField(resource, "uri") ?? "(no URI)";
  const text = stringField(resource, "text");
  if (text !== undefined) return `[Resource: ${uri}]\n${text}`;
  const blob = stringField(resource, "blob");
  const mimeType = stringField(resource, "mimeType") ?? "unknown type";
  const size = blob === undefined ? "no content" : `${Buffer.byteLength(blob, "base64")} bytes`;
  return `[Resource: ${uri} (${mimeType}, ${size}, binary content omitted)]`;
}

function blockContent(block: RawBlock): TextContent | ImageContent {
  const text = stringField(block, "text");
  if (block.type === "text" && text !== undefined) return { type: "text", text };
  const data = stringField(block, "data");
  const mimeType = stringField(block, "mimeType");
  if (block.type === "image" && data !== undefined && mimeType !== undefined) {
    return { type: "image", data, mimeType };
  }
  if (block.type === "resource" && isRecord(block.resource)) {
    return { type: "text", text: describeResource(block.resource) };
  }
  if (block.type === "resource_link") {
    const uri = stringField(block, "uri") ?? "(no URI)";
    return { type: "text", text: `[Resource link: ${stringField(block, "name") ?? uri}] ${uri}` };
  }
  if (block.type === "audio") {
    return { type: "text", text: `[Audio content omitted: ${mimeType ?? "audio/*"}]` };
  }
  return { type: "text", text: JSON.stringify(block) };
}

export function mcpResultContent(result: McpCallResult): (TextContent | ImageContent)[] {
  const blocks = (Array.isArray(result.content) ? result.content : [])
    .filter(isRecord)
    .map(blockContent);
  if (blocks.length > 0) return blocks;
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return [{ type: "text", text: JSON.stringify(result.structuredContent) }];
  }
  return [{ type: "text", text: "(empty result)" }];
}

function parseJson(text: string): { value: unknown } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function digest(value: unknown, level: DigestLevel, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length <= level.stringChars
      ? value
      : `${value.slice(0, level.stringChars)}…[+${value.length - level.stringChars} chars]`;
  }
  if (Array.isArray(value)) {
    if (depth >= level.depth) return `[…${value.length} items]`;
    const kept = value.slice(0, level.arrayItems).map((item) => digest(item, level, depth + 1));
    const hidden = value.length - kept.length;
    return hidden > 0 ? [...kept, `…[+${hidden} more items]`] : kept;
  }
  if (isRecord(value)) {
    if (depth >= level.depth) return `{…${Object.keys(value).length} keys}`;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, digest(item, level, depth + 1)]),
    );
  }
  return value;
}

function fits(text: string, limits: McpTextLimits): boolean {
  return (
    Buffer.byteLength(text, "utf8") <= limits.maxBytes && text.split("\n").length <= limits.maxLines
  );
}

function sliceToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function headTruncate(text: string, limits: McpTextLimits): string {
  const truncation = truncateHead(text, limits);
  return truncation.firstLineExceedsLimit
    ? sliceToBytes(text, limits.maxBytes)
    : truncation.content;
}

export function boundMcpText(text: string, limits: McpTextLimits): BoundedMcpText {
  const parsed = parseJson(text);
  if (!parsed) {
    return fits(text, limits)
      ? { text, truncated: false }
      : { text: headTruncate(text, limits), truncated: true };
  }
  const compact = JSON.stringify(parsed.value);
  if (fits(compact, limits)) return { text: compact, truncated: false };
  for (const level of DIGEST_LEVELS) {
    const digested = JSON.stringify(digest(parsed.value, level));
    if (fits(digested, limits)) return { text: digested, truncated: true, digest: true };
  }
  const smallest = JSON.stringify(digest(parsed.value, DIGEST_LEVELS.at(-1)!));
  return { text: sliceToBytes(smallest, limits.maxBytes), truncated: true, digest: true };
}

function compactMcpText(text: string): string {
  const parsed = parseJson(text);
  return parsed ? JSON.stringify(parsed.value) : text;
}

async function spillFullResult(
  env: ExecutionEnv,
  text: string,
  extension: "json" | "txt",
  context: Context,
): Promise<string | undefined> {
  const path = await env.joinPath(
    [env.cwd, ...SPILL_DIR, `${randomBytes(8).toString("hex")}.${extension}`],
    context,
  );
  if (!path.ok) return undefined;
  const written = await env.writeFile(path.value, redactSecrets(text), context);
  return written.ok ? path.value : undefined;
}

function truncationNotice(
  bounded: BoundedMcpText,
  totalBytes: number,
  spillPath: string | undefined,
): string {
  const view = bounded.digest
    ? `an abbreviated view of ${formatSize(totalBytes)}: long strings, arrays, and deep nesting are shortened; keys, counts, and pagination fields are kept`
    : `the beginning of ${formatSize(totalBytes)}`;
  const full = spillPath
    ? `Full result: ${spillPath} — use read with offset/limit or grep to inspect it`
    : "The full result could not be saved";
  return `[MCP result truncated: showing ${view}. ${full}, or re-query with filters or smaller pages.]`;
}

export async function guardMcpToolResult(
  result: McpCallResult,
  env: ExecutionEnv,
  context: Context,
): Promise<AgentToolResult<undefined>> {
  const blocks = mcpResultContent(result).map((block) =>
    block.type === "text" ? Object.assign(block, { text: compactMcpText(block.text) }) : block,
  );
  const texts = blocks.filter((block): block is TextContent => block.type === "text");
  const images = blocks.filter((block): block is ImageContent => block.type === "image");
  const combined = texts.map((block) => block.text).join("\n");
  if (result.isError) {
    throw new Error(boundMcpText(combined, RESULT_LIMITS).text || "MCP tool call failed");
  }
  if (fits(combined, RESULT_LIMITS)) return { content: blocks, details: undefined };
  const bounded = boundMcpText(combined, RESULT_LIMITS);
  const spillPath = await spillFullResult(env, combined, bounded.digest ? "json" : "txt", context);
  const notice = truncationNotice(bounded, Buffer.byteLength(combined, "utf8"), spillPath);
  return {
    content: [{ type: "text", text: `${bounded.text}\n\n${notice}` }, ...images],
    details: undefined,
  };
}
