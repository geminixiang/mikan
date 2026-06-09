import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, extname, resolve as resolvePath } from "path";

const attachSchema = Type.Object({
  label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
  path: Type.String({ description: "Path to the file to attach" }),
  title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

export function createAttachTool(): {
  tool: AgentTool<typeof attachSchema>;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
} {
  let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

  const tool: AgentTool<typeof attachSchema> = {
    name: "attach",
    label: "attach",
    description:
      "Attach a file to your response. Use this to share files, images, or documents with the user. Only files from /workspace/ can be attached.",
    parameters: attachSchema,
    execute: async (
      _toolCallId: string,
      { path, title }: { label: string; path: string; title?: string },
      signal?: AbortSignal,
    ) => {
      if (!uploadFn) {
        throw new Error("Upload function not configured");
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const absolutePath = resolvePath(path);
      const base = basename(absolutePath);
      const ext = extname(base);
      const fileName = title ? (ext && !title.endsWith(ext) ? `${title}${ext}` : title) : base;

      await uploadFn(absolutePath, fileName);

      return {
        content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setUploadFunction: (fn) => {
      uploadFn = fn;
    },
  };
}
