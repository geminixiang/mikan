import type { Office, Workspace } from "../office/index.js";
import { type ImageContent } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { ConversationMessage } from "../adapter.js";
import { ActorExecutionResolver } from "../execution-resolver.js";
import type { DockerContainerManager } from "../provisioner.js";
import {
  createExecutor,
  type Executor,
  type RuntimePathContext,
  type SandboxConfig,
} from "../sandbox/index.js";
import type { VaultManager } from "../vault/index.js";
import type { RunnerExecutionContext } from "./types.js";

export function translateRuntimePathToHost(
  runtimePath: string,
  pathContext: RuntimePathContext,
): string {
  return pathContext.runtimeToHostPath?.(runtimePath) ?? runtimePath;
}

function isWithinPathRoot(path: string, root: string): boolean {
  const pathRelative = relative(root, path);
  return (
    pathRelative === "" ||
    (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative))
  );
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => segment === "..");
}

export function translateAttachPathToHost(
  filePath: string,
  pathContext: RuntimePathContext,
): string {
  if (!pathContext.runtimeToHostPath) {
    throw new Error(
      "Cannot attach files: this sandbox has no host-backed runtime path mapping; attachments are unavailable for remote sandboxes such as Cloudflare or Firecracker",
    );
  }
  if (hasParentTraversal(filePath)) {
    throw new Error("Cannot attach files: parent-directory traversal is not allowed");
  }

  const runtimeRoot = resolve(pathContext.runtimeWorkspaceRoot);
  const runtimePath = posix.isAbsolute(filePath)
    ? filePath
    : posix.join(pathContext.runtimeWorkspaceRoot, filePath);
  const normalizedRuntimePath = resolve(runtimePath);
  if (!isWithinPathRoot(normalizedRuntimePath, runtimeRoot)) {
    throw new Error("Cannot attach files: path must be within the runtime workspace");
  }

  const hostRoot = resolve(pathContext.hostWorkspaceRoot);
  const translatedPath = pathContext.runtimeToHostPath(runtimePath);
  const hostPath = resolve(translatedPath);
  if (!isWithinPathRoot(hostPath, hostRoot)) {
    throw new Error("Cannot attach files: path must be within the host workspace");
  }

  return hostPath;
}

/**
 * Normalize an attachment path using runtime lexical semantics only. The
 * executor remains the authority for reading the resulting runtime path.
 */
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

export async function withStagedRuntimeFile(
  executor: Executor,
  runtimePath: string,
  upload: (stagedPath: string) => Promise<void>,
): Promise<void> {
  const content = Buffer.from(await executor.readFileBase64(runtimePath), "base64");
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

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
  return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

export async function collectMessageAttachments(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
  readAttachment?: (runtimePath: string) => Promise<string>,
): Promise<{ imageAttachments: ImageContent[]; nonImagePaths: string[] }> {
  const imageAttachments: ImageContent[] = [];
  const nonImagePaths: string[] = [];

  for (const attachment of message.attachments || []) {
    const runtimePath = `${workspacePath}/${attachment.localPath}`;
    const hostPath = pathContext?.runtimeToHostPath?.(runtimePath) ?? runtimePath;
    const mimeType = getImageMimeType(attachment.localPath);

    if (mimeType && existsSync(hostPath) && readAttachment) {
      try {
        imageAttachments.push({
          type: "image",
          mimeType,
          data: await readAttachment(runtimePath),
        });
      } catch {
        nonImagePaths.push(runtimePath);
      }
    } else {
      nonImagePaths.push(runtimePath);
    }
  }

  return { imageAttachments, nonImagePaths };
}

export function buildRuntimePaths(runtimeWorkspaceRoot: string, office: Office) {
  const workspaceRoot = runtimeWorkspaceRoot.replace(/\/+$/, "") || "/";
  const conversationPath = posix.join(workspaceRoot, office.key);
  return {
    workspaceRoot,
    conversationPath,
    scratchPath: posix.join(conversationPath, "scratch"),
  };
}

export function createRunnerExecutionContext(
  sandboxConfig: SandboxConfig,
  vaultManager: VaultManager | undefined,
  provisioner: DockerContainerManager | undefined,
  workspace: Workspace,
): RunnerExecutionContext {
  const executionResolver =
    vaultManager && sandboxConfig.type !== "host"
      ? new ActorExecutionResolver(sandboxConfig, vaultManager, provisioner, workspace)
      : undefined;

  // activeExecutor is replaced at the start of each run() call when executionResolver
  // is present, so the stable `executor` wrapper always delegates to the latest resolved value.
  let activeExecutor: Executor =
    executionResolver !== undefined
      ? createExecutor({ type: "host" })
      : createExecutor(sandboxConfig);
  const executor: Executor = {
    exec(command, options) {
      return activeExecutor.exec(command, options);
    },
    readFile(path, options) {
      return activeExecutor.readFile(path, options);
    },
    readFileBase64(path, options) {
      return activeExecutor.readFileBase64(path, options);
    },
    writeFile(path, content, options) {
      return activeExecutor.writeFile(path, content, options);
    },
    getWorkspacePath(hostPath) {
      return activeExecutor.getWorkspacePath(hostPath);
    },
    getSandboxConfig() {
      return activeExecutor.getSandboxConfig();
    },
    getPathContext(hostWorkspaceRoot) {
      return activeExecutor.getPathContext(hostWorkspaceRoot);
    },
  };

  return {
    executionResolver,
    executor,
    getPathContext: () => executor.getPathContext(workspace.root),
    async resolveExecutorForRun(context): Promise<void> {
      if (!executionResolver) return;
      activeExecutor = await executionResolver.resolve(context);
    },
  };
}

/**
 * Extension host services over mikan's runtime infrastructure: schedules
 * become event files under `<workspaceDir>/events` (picked up live by
 * EventsWatcher), secrets come from `vaults/extensions/<slug>/env`, and
 * notify posts through the platform bots when main.ts provides a notifier.
 */
