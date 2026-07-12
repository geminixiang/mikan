import { createExecutor, type RuntimePathContext, type SandboxConfig } from "../sandbox/index.js";
import { createMountedRuntimePathContext } from "../sandbox/path-context.js";
import { posix } from "path";

export function getUnresolvedSandboxPathContext(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  if (sandboxConfig.type === "image") {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  return createExecutor(sandboxConfig).getPathContext(hostWorkspaceRoot);
}

export function translateRuntimePathToHost(
  runtimePath: string,
  pathContext: RuntimePathContext,
): string {
  return pathContext.runtimeToHostPath?.(runtimePath) ?? runtimePath;
}

export function translateAttachPathToHost(
  filePath: string,
  pathContext: RuntimePathContext,
): string {
  const runtimePath = posix.isAbsolute(filePath)
    ? filePath
    : posix.join(pathContext.runtimeWorkspaceRoot, filePath);
  return translateRuntimePathToHost(runtimePath, pathContext);
}
