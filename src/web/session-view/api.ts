import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { createOfficeAddress } from "../../office/address.js";
import * as log from "../../log.js";
import {
  loadSessionViewModel,
  resolveRequestedSessionFile,
  type SessionViewModel,
} from "./service.js";
import type { InMemorySessionViewTokenStore } from "./store.js";
import type { SessionViewInteractiveOptions, SessionViewToken } from "./types.js";
import type { SessionViewApiResponse } from "@geminixiang/mikan-daemon-web-bridge";

/**
 * JSON session-view API for the React SPA. One endpoint:
 *   GET /api/session/view?token=…&session=…
 * → { model, isRunning, displayedSessionKey, conversationId, expiresAt }
 *
 * The SPA subscribes to the existing `/session/stream` SSE (JSON events) for
 * live updates and re-fetches this endpoint, and posts to the existing
 * `/session/message` (already JSON) to send.
 */

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function resolveDisplayedSessionKey(entry: SessionViewToken, sessionFile: string): string {
  if (entry.platform === "slack") {
    const fileName = basename(sessionFile, ".jsonl");
    if (/^\d+\.\d+$/.test(fileName)) {
      return `${entry.conversationId}:${fileName}`;
    }
    return entry.conversationId;
  }
  return entry.sessionKey;
}

export function handleSessionViewApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionViewTokenStore?: InMemorySessionViewTokenStore,
  interactive?: SessionViewInteractiveOptions,
): boolean {
  if (req.method !== "GET" || url.pathname !== "/api/session/view") return false;

  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token || !sessionViewTokenStore) {
    json(res, 400, { error: "This session link is invalid or has expired." });
    return true;
  }

  const entry = sessionViewTokenStore.peek(token);
  if (!entry) {
    json(res, 400, { error: "This session link is invalid or has expired." });
    return true;
  }

  const requestedSession = url.searchParams.get("session");
  let targetSessionFile: string | null;
  try {
    targetSessionFile = resolveRequestedSessionFile(entry.sessionFile, requestedSession);
  } catch (error) {
    log.logWarning(
      `[${entry.conversationId}] Corrupted session file referenced for ${entry.sessionFile}`,
      error instanceof Error ? error.message : String(error),
    );
    json(res, 500, { error: "The selected session file appears to be corrupted." });
    return true;
  }
  if (!targetSessionFile) {
    json(res, 400, { error: "The selected session link is invalid." });
    return true;
  }

  let model: SessionViewModel;
  try {
    model = loadSessionViewModel(targetSessionFile);
  } catch (error) {
    log.logWarning(
      `[${entry.conversationId}] Failed to load session ${entry.sessionFile}`,
      error instanceof Error ? error.message : String(error),
    );
    json(res, 500, { error: "The session could not be loaded right now." });
    return true;
  }

  const displayedSessionKey = resolveDisplayedSessionKey(entry, targetSessionFile);
  const isRunning =
    interactive?.handler.isRunning(
      createOfficeAddress(entry.platform, entry.conversationId),
      displayedSessionKey,
    ) ?? false;

  json(res, 200, {
    model,
    isRunning,
    displayedSessionKey,
    conversationId: entry.conversationId,
    expiresAt: entry.expiresAt,
  } satisfies SessionViewApiResponse);
  return true;
}
