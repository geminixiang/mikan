import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox/index.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateTail,
} from "@earendil-works/pi-agent-core";

const bashSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what this command does (shown to user)",
  }),
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export function createBashTool(
  executor: Executor,
  options?: { hostWorkspaceRoot?: string },
): AgentTool<typeof bashSchema> {
  return {
    name: "bash",
    label: "bash",
    executionMode: "sequential",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    execute: async (
      _toolCallId: string,
      { command, timeout }: { label: string; command: string; timeout?: number },
      signal?: AbortSignal,
    ) => {
      let tempFilePath: string | undefined;

      const result = await executor.exec(command, { timeout, signal });
      let output = "";
      if (result.stdout) output += result.stdout;
      if (result.stderr) {
        if (output) output += "\n";
        output += result.stderr;
      }

      const totalBytes = Buffer.byteLength(output, "utf-8");

      // Spill the full output into the runtime workspace when it exceeds the
      // limit; the executor owns transport, so the advertised path is valid
      // where the model's follow-up read/bash actually runs.
      if (totalBytes > DEFAULT_MAX_BYTES) {
        const runtimeRoot = executor.getPathContext(
          options?.hostWorkspaceRoot ?? process.cwd(),
        ).runtimeWorkspaceRoot;
        const id = randomBytes(8).toString("hex");
        const spillPath = `${runtimeRoot.replace(/\/+$/, "")}/.mikan/bash-output/${id}.log`;
        try {
          await executor.writeFile(spillPath, output, { signal });
          tempFilePath = spillPath;
        } catch {
          tempFilePath = undefined;
        }
      }

      // Apply tail truncation
      const truncation = truncateTail(output);
      let outputText = truncation.content || "(no output)";

      // Build details with truncation info
      let details: BashToolDetails | undefined;

      if (truncation.truncated) {
        details = {
          truncation,
          fullOutputPath: tempFilePath,
        };

        // Build actionable notice
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        const fullOutputNote = tempFilePath
          ? ` Full output: ${tempFilePath}`
          : " Full output unavailable (spill failed).";

        if (truncation.lastLinePartial) {
          // Edge case: last line alone > 50KB
          const lastLineSize = formatSize(
            Buffer.byteLength(output.split("\n").pop() || "", "utf-8"),
          );
          outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).${fullOutputNote}]`;
        } else if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${fullOutputNote}]`;
        } else {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${fullOutputNote}]`;
        }
      }

      if (result.code !== 0) {
        throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
      }

      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}
