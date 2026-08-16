import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebAuthRequestOptions } from "../auth/portal.js";
import {
  authenticateWebRequest,
  clearWebSessionCookies,
  enforceWebMutationRequest,
  sendWebJson,
} from "../auth/portal.js";
import { isRecord } from "../../utils/file-guards.js";
import { readJsonBody } from "../portal-shell.js";
import type { WebHarnessService } from "./service.js";

const MAX_WORKSPACE_BODY_BYTES = 16 * 1024;

export interface WebHarnessRequestOptions {
  readonly auth: WebAuthRequestOptions;
  readonly service: WebHarnessService;
}

export async function handleWebHarnessRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: WebHarnessRequestOptions,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/web/workspaces")) return false;

  const authenticated = authenticateWebRequest(req, options.auth.registry, req.method !== "GET");
  if (!authenticated) {
    clearWebSessionCookies(res);
    sendWebJson(res, 401, { error: "Authentication required" });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/web/workspaces") {
    sendWebJson(res, 200, { workspaces: options.service.listWorkspaces(authenticated.account) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/web/workspaces") {
    if (!enforceWebMutationRequest(req, res, options.auth.publicBaseUrl)) return true;
    const body = await readJsonBody(req, res, MAX_WORKSPACE_BODY_BYTES);
    if (!body) return true;
    const name = readWorkspaceName(body);
    if (!name) {
      sendWebJson(res, 400, { error: "Workspace name is required" });
      return true;
    }
    try {
      const workspace = options.service.createWorkspace(authenticated.account, name);
      sendWebJson(res, 201, { workspace });
    } catch (error) {
      sendWebJson(res, 400, { error: publicWorkspaceError(error) });
    }
    return true;
  }

  const match = /^\/api\/web\/workspaces\/([^/]+)(?:\/(sessions|history))?$/.exec(url.pathname);
  if (!match) return false;
  const workspaceId = decodePathSegment(match[1]);
  if (!workspaceId) {
    sendWebJson(res, 404, { error: "Workspace not found" });
    return true;
  }
  const operation = match[2];

  if (req.method === "PATCH" && !operation) {
    if (!enforceWebMutationRequest(req, res, options.auth.publicBaseUrl)) return true;
    const body = await readJsonBody(req, res, MAX_WORKSPACE_BODY_BYTES);
    if (!body) return true;
    const name = readWorkspaceName(body);
    if (!name) {
      sendWebJson(res, 400, { error: "Workspace name is required" });
      return true;
    }
    try {
      const workspace = options.service.renameWorkspace(authenticated.account, workspaceId, name);
      if (!workspace) sendWebJson(res, 404, { error: "Workspace not found" });
      else sendWebJson(res, 200, { workspace });
    } catch (error) {
      sendWebJson(res, 400, { error: publicWorkspaceError(error) });
    }
    return true;
  }

  if (req.method === "GET" && operation === "sessions") {
    const sessions = await options.service.listSessions(authenticated.account, workspaceId);
    if (!sessions) sendWebJson(res, 404, { error: "Workspace not found" });
    else sendWebJson(res, 200, { sessions });
    return true;
  }

  if (req.method === "GET" && operation === "history") {
    const history = await options.service.loadHistory(
      authenticated.account,
      workspaceId,
      url.searchParams.get("sessionId") ?? undefined,
    );
    if (!history) sendWebJson(res, 404, { error: "Session not found" });
    else sendWebJson(res, 200, { session: history });
    return true;
  }

  return false;
}

function readWorkspaceName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  return value.name;
}

function decodePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !decoded.includes("/") && !decoded.includes("\\") ? decoded : null;
  } catch {
    return null;
  }
}

function publicWorkspaceError(error: unknown): string {
  return error instanceof Error && error.message.startsWith("Workspace name")
    ? error.message
    : "Workspace request failed";
}
