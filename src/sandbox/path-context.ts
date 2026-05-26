import { join } from "node:path";
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

export function translateMountedRuntimePathToHost(
  runtimePath: string,
  runtimeWorkspaceRoot: string,
  hostWorkspaceRoot: string,
): string {
  const runtimeRoot = runtimeWorkspaceRoot.replace(/\/+$/, "");
  if (runtimePath === runtimeRoot) {
    return hostWorkspaceRoot;
  }

  const workspacePrefix = `${runtimeRoot}/`;
  if (runtimePath.startsWith(workspacePrefix)) {
    return join(hostWorkspaceRoot, runtimePath.slice(workspacePrefix.length));
  }

  return runtimePath;
}
