import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { extname } from "node:path";
import type { Executor } from "../../sandbox/index.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@earendil-works/pi-agent-core";

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_MIME_TYPES[ext] || null;
}

const readSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're reading and why (shown to user)",
  }),
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  byteOffset: Type.Optional(
    Type.Number({
      description:
        "Byte offset into the first selected line. Use to page through a line too large to return whole.",
    }),
  ),
});

/**
 * Trim bytes that would split a multi-byte UTF-8 sequence at the slice end, so
 * paging through a long line never emits a replacement character at the seam.
 */
function trimToCharBoundary(buffer: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, buffer.length); back++) {
    const byte = buffer[buffer.length - back];
    if (byte === undefined || (byte & 0xc0) === 0x80) continue; // continuation byte; keep walking back
    const needed = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    return back === needed ? buffer : buffer.subarray(0, buffer.length - back);
  }
  return buffer;
}

interface ReadToolDetails {
  truncation?: TruncationResult;
}

/**
 * The bracketed notice appended after the content: what was shown and which
 * offset resumes it. Empty when the selection already reached end of file.
 */
function continuationNotice(state: {
  truncation: TruncationResult;
  startLine: number;
  totalFileLines: number;
  userLimitedLines: number | undefined;
}): string {
  const { truncation, startLine, totalFileLines, userLimitedLines } = state;
  if (truncation.truncated) {
    const endLine = startLine + truncation.outputLines - 1;
    const limit =
      truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
    return `\n\n[Showing lines ${startLine}-${endLine} of ${totalFileLines}${limit}. Use offset=${endLine + 1} to continue]`;
  }
  const shownThrough = startLine - 1 + (userLimitedLines ?? 0);
  if (userLimitedLines === undefined || shownThrough >= totalFileLines) return "";
  return `\n\n[${totalFileLines - shownThrough} more lines in file. Use offset=${startLine + userLimitedLines} to continue]`;
}

export function createReadTool(executor: Executor): AgentTool<typeof readSchema> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files, and byteOffset to page through a single line larger than the byte limit.`,
    parameters: readSchema,
    execute: async (
      _toolCallId: string,
      {
        path,
        offset,
        limit,
        byteOffset,
      }: {
        label: string;
        path: string;
        offset?: number;
        limit?: number;
        byteOffset?: number;
      },
      signal?: AbortSignal,
    ): Promise<{
      content: (TextContent | ImageContent)[];
      details: ReadToolDetails | undefined;
    }> => {
      const mimeType = isImageFile(path);

      if (mimeType) {
        // Binary content rides the executor's own transport, never shell argv.
        const base64 = await executor.readFileBase64(path, { signal });

        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: base64, mimeType },
          ],
          details: undefined,
        };
      }

      // One transport read; line selection is plain code, not shell strings.
      const fileText = await executor.readFile(path, { signal });
      const fileLines = fileText.split("\n");
      const totalFileLines = fileLines.length;

      // Apply offset if specified (1-indexed)
      const startLine = offset ? Math.max(1, offset) : 1;

      // Check if offset is out of bounds
      if (startLine > totalFileLines) {
        throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
      }

      let selectedContent = startLine === 1 ? fileText : fileLines.slice(startLine - 1).join("\n");
      let userLimitedLines: number | undefined;

      // Apply user limit if specified
      if (limit !== undefined) {
        const lines = selectedContent.split("\n");
        const endLine = Math.min(limit, lines.length);
        selectedContent = lines.slice(0, endLine).join("\n");
        userLimitedLines = endLine;
      }

      // Apply truncation (respects both line and byte limits)
      const truncation = truncateHead(selectedContent);

      if (truncation.firstLineExceedsLimit) {
        // Serve the line in byte-addressed slices rather than pointing at
        // another tool: the caller may not hold one, and a dead end there
        // costs a whole run.
        const lineBuffer = Buffer.from(selectedContent.split("\n")[0] ?? "", "utf-8");
        const start = Math.max(0, Math.min(byteOffset ?? 0, lineBuffer.length));
        const slice = trimToCharBoundary(lineBuffer.subarray(start, start + DEFAULT_MAX_BYTES));
        const end = start + slice.length;
        const more =
          end < lineBuffer.length ? ` Use byteOffset=${end} to continue]` : " End of line reached]";
        return {
          content: [
            {
              type: "text",
              text: `${slice.toString("utf-8")}\n\n[Line ${startLine} is ${formatSize(lineBuffer.length)}; showing bytes ${start}-${end}.${more}`,
            },
          ],
          details: { truncation },
        };
      }

      // Everything else returns the truncated content plus, when the file has
      // more to give, one actionable notice naming the next offset.
      const notice = continuationNotice({
        truncation,
        startLine,
        totalFileLines,
        userLimitedLines,
      });
      return {
        content: [{ type: "text", text: truncation.content + notice }],
        details: truncation.truncated ? { truncation } : undefined,
      };
    },
  };
}
