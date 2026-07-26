import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimePathContext } from "./types.js";

export function createMountedRuntimePathContext(
  hostWorkspaceRoot: string,
  runtimeWorkspaceRoot: string,
): RuntimePathContext {
  return {
    hostWorkspaceRoot,
    runtimeWorkspaceRoot,
    runtimeToHostPath: (runtimePath) =>
      translateMountedRuntimePathToHost(runtimePath, runtimeWorkspaceRoot, hostWorkspaceRoot),
  };
}

function translateMountedRuntimePathToHost(
  runtimePath: string,
  runtimeWorkspaceRoot: string,
  hostWorkspaceRoot: string,
): string {
  if (!isAbsolute(runtimePath)) {
    return runtimePath;
  }

  const runtimeRoot = resolve(runtimeWorkspaceRoot);
  const normalizedRuntimePath = resolve(runtimePath);
  const runtimeRelativePath = relative(runtimeRoot, normalizedRuntimePath);
  const escapesRuntimeRoot =
    runtimeRelativePath === ".." ||
    runtimeRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelativePath);

  if (escapesRuntimeRoot) {
    return runtimePath;
  }

  const hostRoot = resolve(hostWorkspaceRoot);
  const hostPath = resolve(hostRoot, runtimeRelativePath);
  const hostRelativePath = relative(hostRoot, hostPath);
  const escapesHostRoot =
    hostRelativePath === ".." ||
    hostRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(hostRelativePath);

  return escapesHostRoot ? runtimePath : hostPath;
}
