import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";
import type { Executor } from "../sandbox/index.js";

/** A diff part's lines, without the empty string a trailing newline leaves behind. */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isChange(part: Diff.Change | undefined): boolean {
  return part !== undefined && (part.added === true || part.removed === true);
}

/**
 * The slice of an unchanged run that survives into the diff: `contextLines`
 * leading into a change and `contextLines` trailing out of one. A run that
 * touches no change is dropped entirely; an elided end is reported so the
 * caller can mark it with `...`.
 */
function contextWindow(
  lines: string[],
  options: { afterChange: boolean; beforeChange: boolean; contextLines: number },
): { lines: string[]; elidedHead: boolean; elidedTail: boolean } {
  if (!options.afterChange && !options.beforeChange) {
    return { lines: [], elidedHead: false, elidedTail: false };
  }
  const start = options.afterChange ? 0 : Math.max(0, lines.length - options.contextLines);
  const end = options.beforeChange
    ? lines.length
    : Math.min(lines.length, start + options.contextLines);
  return { lines: lines.slice(start, end), elidedHead: start > 0, elidedTail: end < lines.length };
}

/**
 * Generate a unified diff string with line numbers and context.
 *
 * Added and removed runs are numbered in their own file's sequence. An
 * unchanged run is numbered from the old file's current line and advances both
 * counters by its full length, so the lines shown after an elision carry the
 * run's opening numbers rather than their true position.
 */
function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
  const parts = Diff.diffLines(oldContent, newContent);
  const width = String(
    Math.max(oldContent.split("\n").length, newContent.split("\n").length),
  ).length;
  const number =
    (marker: string, start: number) =>
    (line: string, offset: number): string =>
      `${marker}${String(start + offset).padStart(width, " ")} ${line}`;
  const elision = ` ${"".padStart(width, " ")} ...`;

  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const [index, part] of parts.entries()) {
    const lines = splitLines(part.value);
    // A changed run is numbered against its own file and advances only that
    // file's counter; the other side stands still.
    if (part.added || part.removed) {
      const toNew = part.added === true;
      output.push(...lines.map(number(toNew ? "+" : "-", toNew ? newLineNum : oldLineNum)));
      if (toNew) newLineNum += lines.length;
      else oldLineNum += lines.length;
      continue;
    }
    const window = contextWindow(lines, {
      afterChange: isChange(parts[index - 1]),
      beforeChange: isChange(parts[index + 1]),
      contextLines,
    });
    if (window.elidedHead) output.push(elision);
    output.push(...window.lines.map(number(" ", oldLineNum)));
    if (window.elidedTail) output.push(elision);
    oldLineNum += lines.length;
    newLineNum += lines.length;
  }

  return output.join("\n");
}

const editSchema = Type.Object({
  label: Type.String({
    description: "Brief description of the edit you're making (shown to user)",
  }),
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" }),
});

export function createEditTool(executor: Executor): AgentTool<typeof editSchema> {
  return {
    name: "edit",
    label: "edit",
    executionMode: "sequential",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    parameters: editSchema,
    execute: async (
      _toolCallId: string,
      { path, oldText, newText }: { label: string; path: string; oldText: string; newText: string },
      signal?: AbortSignal,
    ) => {
      let content: string;
      try {
        content = await executor.readFile(path, { signal });
      } catch (err) {
        throw new Error(
          err instanceof Error && err.message ? err.message : `File not found: ${path}`,
          {
            cause: err,
          },
        );
      }

      // Check if old text exists
      if (!content.includes(oldText)) {
        throw new Error(
          `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
        );
      }

      // Count occurrences
      const occurrences = content.split(oldText).length - 1;

      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
        );
      }

      // Perform replacement
      const index = content.indexOf(oldText);
      const newContent =
        content.substring(0, index) + newText + content.substring(index + oldText.length);

      if (content === newContent) {
        throw new Error(
          `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        );
      }

      // Write the file back
      await executor.writeFile(path, newContent, { signal });

      return {
        content: [
          {
            type: "text",
            text: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`,
          },
        ],
        details: { diff: generateDiffString(content, newContent) },
      };
    },
  };
}
