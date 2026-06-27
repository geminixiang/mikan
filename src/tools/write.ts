import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { dirname } from "path";
import type { Executor } from "../sandbox/index.js";
import { shellEscape } from "../sandbox/utils.js";

const writeSchema = Type.Object({
  label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(executor: Executor): AgentTool<typeof writeSchema> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (
      _toolCallId: string,
      { path, content }: { label: string; path: string; content: string },
      signal?: AbortSignal,
    ) => {
      const dir = dirname(path);
      const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`;

      const result = await executor.exec(cmd, { signal });
      if (result.code !== 0) {
        throw new Error(result.stderr || `Failed to write file: ${path}`);
      }

      return {
        content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
        details: undefined,
      };
    },
  };
}
