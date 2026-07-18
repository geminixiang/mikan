import { join } from "node:path";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "../utils/file-guards.js";
import {
  conversationSettingsPath,
  loadGlobalSettings,
  resolveConversationSettings,
} from "../config.js";
import * as log from "../log.js";
import type { ImageWorkspaceMountMode } from "../types.js";
import type { WorkspaceProjection } from "./types.js";

export function resolveWorkspaceProjection(
  hostWorkspaceRoot: string | undefined,
  conversationId: string,
): WorkspaceProjection {
  assertConversationPathSegment(conversationId);
  const mode = readWorkspaceProjectionMode(hostWorkspaceRoot, conversationId);
  if (!hostWorkspaceRoot) return { mode, mounts: [] };
  if (mode === "full") {
    return {
      mode,
      mounts: [{ source: hostWorkspaceRoot, target: "/workspace" }],
    };
  }

  const conversationDir = join(hostWorkspaceRoot, conversationId);
  ensureDirExists(conversationDir);
  return {
    mode,
    mounts: [
      { source: join(hostWorkspaceRoot, "MEMORY.md"), target: "/workspace/MEMORY.md" },
      { source: join(hostWorkspaceRoot, "skills"), target: "/workspace/skills" },
      { source: join(hostWorkspaceRoot, "events"), target: "/workspace/events" },
      { source: conversationDir, target: `/workspace/${conversationId}` },
    ],
  };
}

export function readWorkspaceProjectionMode(
  hostWorkspaceRoot: string | undefined,
  conversationId: string,
): ImageWorkspaceMountMode {
  assertConversationPathSegment(conversationId);
  const globalDefault = readGlobalMode();
  if (!hostWorkspaceRoot) return globalDefault;

  const conversationDir = join(hostWorkspaceRoot, conversationId);
  try {
    return (
      resolveConversationSettings(conversationDir).sandbox?.image?.workspaceMount ?? globalDefault
    );
  } catch (err) {
    log.logWarning(
      "Falling back while resolving conversation workspace projection",
      err instanceof Error ? err.message : String(err),
    );
    return readFallback(conversationSettingsPath(conversationDir)) ?? globalDefault;
  }
}

function assertConversationPathSegment(conversationId: string): void {
  if (
    conversationId.length === 0 ||
    conversationId === "." ||
    conversationId === ".." ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw new Error("Conversation id must be a safe path segment");
  }
}

function readGlobalMode(): ImageWorkspaceMountMode {
  try {
    return loadGlobalSettings().sandbox?.image?.workspaceMount ?? "private";
  } catch (err) {
    log.logWarning(
      "Using default workspace projection because global settings could not be read",
      err instanceof Error ? err.message : String(err),
    );
    return "private";
  }
}

function readFallback(settingsPath: string): ImageWorkspaceMountMode | undefined {
  try {
    const raw = readJsonFileIfExists(
      settingsPath,
      (value): value is { sandbox?: { image?: { workspaceMount?: ImageWorkspaceMountMode } } } =>
        isRecord(value),
      () => "Ignoring malformed conversation settings while resolving workspace projection",
    );
    return raw?.sandbox?.image?.workspaceMount;
  } catch (err) {
    log.logWarning(
      "Ignoring malformed conversation settings fallback while resolving workspace projection",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}
