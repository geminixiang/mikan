import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";

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

      const base = basename(path);
      const ext = extname(base);
      const fileName = title ? (ext && !title.endsWith(ext) ? `${title}${ext}` : title) : base;

      await uploadFn(path, fileName);

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

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === "..");
}

export function normalizeAttachRuntimePath(filePath: string, runtimeWorkspaceRoot: string): string {
  if (hasParentTraversal(filePath)) {
    throw new Error("Cannot attach files: parent-directory traversal is not allowed");
  }

  const runtimeRoot = posix.resolve(runtimeWorkspaceRoot);
  const runtimePath = posix.resolve(runtimeRoot, filePath);
  const runtimeRelativePath = posix.relative(runtimeRoot, runtimePath);
  if (
    runtimeRelativePath === ".." ||
    runtimeRelativePath.startsWith("../") ||
    posix.isAbsolute(runtimeRelativePath)
  ) {
    throw new Error("Cannot attach files: path must be within the runtime workspace");
  }
  return runtimePath;
}

export async function readRuntimeFile(
  env: ExecutionEnv | undefined,
  runtimePath: string,
): Promise<Uint8Array> {
  if (!env) throw new Error("No execution environment: the run has not resolved its sandbox");
  return getOrThrow(await env.readBinaryFile(runtimePath, BACKGROUND_CONTEXT));
}

export async function withStagedRuntimeFile(
  env: ExecutionEnv | undefined,
  runtimePath: string,
  upload: (stagedPath: string) => Promise<void>,
): Promise<void> {
  const content = await readRuntimeFile(env, runtimePath);
  let stagingDir: string | undefined;
  try {
    stagingDir = await mkdtemp(join(tmpdir(), "mikan-upload-"));
    await chmod(stagingDir, 0o700);
    const stagedPath = join(stagingDir, basename(runtimePath));
    await writeFile(stagedPath, content, { mode: 0o600, flag: "wx" });
    await chmod(stagedPath, 0o600);
    await upload(stagedPath);
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
  }
}
