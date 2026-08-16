import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebAccount } from "../auth/types.js";
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
import type { WebStreamFrame } from "./protocol.js";

const MAX_WORKSPACE_BODY_BYTES = 16 * 1024;
const MAX_PROMPT_BODY_BYTES = 128 * 1024;
const MAX_PROMPT_TEXT_LENGTH = 100_000;
const MAX_CLIENT_REQUEST_ID_LENGTH = 200;

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

  if (url.pathname === "/api/web/workspaces") {
    return handleWorkspaceCollection(req, res, authenticated.account, options);
  }

  const match =
    /^\/api\/web\/workspaces\/([^/]+)(?:\/(sessions|history|prompt|cancel|stream))?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const workspaceId = decodePathSegment(match[1]);
  if (!workspaceId) {
    sendWebJson(res, 404, { error: "Workspace not found" });
    return true;
  }

  return handleWorkspaceResource(req, res, {
    url,
    account: authenticated.account,
    workspaceId,
    operation: match[2],
    options,
  });
}

async function handleWorkspaceCollection(
  req: IncomingMessage,
  res: ServerResponse,
  account: WebAccount,
  options: WebHarnessRequestOptions,
): Promise<boolean> {
  if (req.method === "GET") {
    sendWebJson(res, 200, {
      workspaces: options.service.listWorkspaces(account),
    });
    return true;
  }
  if (req.method !== "POST") return false;
  if (!enforceWebMutationRequest(req, res, options.auth.publicBaseUrl)) return true;
  const body = await readJsonBody(req, res, MAX_WORKSPACE_BODY_BYTES);
  if (!body) return true;
  const name = readWorkspaceName(body);
  if (!name) {
    sendWebJson(res, 400, { error: "Workspace name is required" });
    return true;
  }
  try {
    sendWebJson(res, 201, {
      workspace: options.service.createWorkspace(account, name),
    });
  } catch (error) {
    sendWebJson(res, 400, { error: publicWorkspaceError(error) });
  }
  return true;
}

async function handleWorkspaceResource(
  req: IncomingMessage,
  res: ServerResponse,
  resource: {
    url: URL;
    account: WebAccount;
    workspaceId: string;
    operation: string | undefined;
    options: WebHarnessRequestOptions;
  },
): Promise<boolean> {
  const { url, account, workspaceId, operation, options } = resource;
  if (req.method === "PATCH" && !operation) {
    return handleRename(req, res, account, workspaceId, options);
  }
  if (req.method === "POST" && operation === "prompt") {
    return handlePrompt(req, res, account, workspaceId, options);
  }
  if (req.method === "POST" && operation === "cancel") {
    return handleCancel(req, res, account, workspaceId, options);
  }
  if (req.method === "GET" && operation === "stream") {
    return handleStream(req, res, account, workspaceId, options);
  }
  if (req.method === "GET" && operation === "sessions") {
    const sessions = await options.service.listSessions(account, workspaceId);
    if (!sessions) sendWebJson(res, 404, { error: "Workspace not found" });
    else sendWebJson(res, 200, { sessions });
    return true;
  }
  if (req.method === "GET" && operation === "history") {
    const history = await options.service.loadHistory(
      account,
      workspaceId,
      url.searchParams.get("sessionId") ?? undefined,
    );
    if (!history) sendWebJson(res, 404, { error: "Session not found" });
    else sendWebJson(res, 200, { session: history });
    return true;
  }
  return false;
}

async function handleRename(
  req: IncomingMessage,
  res: ServerResponse,
  account: WebAccount,
  workspaceId: string,
  options: WebHarnessRequestOptions,
): Promise<true> {
  if (!enforceWebMutationRequest(req, res, options.auth.publicBaseUrl)) return true;
  const body = await readJsonBody(req, res, MAX_WORKSPACE_BODY_BYTES);
  if (!body) return true;
  const name = readWorkspaceName(body);
  if (!name) {
    sendWebJson(res, 400, { error: "Workspace name is required" });
    return true;
  }
  try {
    const workspace = options.service.renameWorkspace(account, workspaceId, name);
    if (!workspace) sendWebJson(res, 404, { error: "Workspace not found" });
    else sendWebJson(res, 200, { workspace });
  } catch (error) {
    sendWebJson(res, 400, { error: publicWorkspaceError(error) });
  }
  return true;
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  account: WebAccount,
  workspaceId: string,
  options: WebHarnessRequestOptions,
): Promise<true> {
  if (!enforceWebMutationRequest(req, res, options.auth.publicBaseUrl)) return true;
  const body = await readJsonBody(req, res, MAX_PROMPT_BODY_BYTES);
  if (!body) return true;
  const prompt = readPrompt(body);
  if (!prompt) {
    sendWebJson(res, 400, { error: "Invalid prompt request" });
    return true;
  }
  const result = options.service.submitPrompt(account, workspaceId, prompt);
  if (result.status === "not-found") {
    sendWebJson(res, 404, { error: "Workspace not found" });
  } else if (result.status === "unavailable") {
    sendWebJson(res, 503, { error: "Web runtime unavailable" });
  } else if (result.status === "busy") {
    sendWebJson(res, 409, { error: "Workspace is busy" });
  } else {
    sendWebJson(res, 202, {
      accepted: true,
      requestId: result.requestId,
      clientRequestId: prompt.clientRequestId,
      placement: result.placement,
    });
  }
  return true;
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  account: WebAccount,
  workspaceId: string,
  options: WebHarnessRequestOptions,
): Promise<true> {
  const snapshot = options.service.streamSnapshot(account, workspaceId);
  if (snapshot.status === "not-found") {
    sendWebJson(res, 404, { error: "Workspace not found" });
    return true;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (frame: WebStreamFrame): void => {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  };
  const subscription = options.service.subscribe(account, workspaceId, send);
  if (!subscription) {
    res.end();
    return true;
  }

  const history = await options.service.loadCurrentHistory(account, workspaceId);
  subscription.flush([
    {
      type: "stream.ready",
      generation: snapshot.generation,
      workspaceId: snapshot.workspace.id,
    },
    { type: "workspace.snapshot", workspace: snapshot.workspace },
    { type: "session.snapshot", session: history },
    { type: "run.snapshot", run: subscription.initial.run },
    { type: "queue.snapshot", items: subscription.initial.queue },
    { type: "subagents.snapshot", items: subscription.initial.subagents },
    ...subscription.initial.tools.map(
      (tool) =>
        ({
          type: tool.status === "running" ? "tool.started" : "tool.finished",
          runId: tool.runId,
          tool,
        }) satisfies WebStreamFrame,
    ),
  ]);

  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  keepalive.unref();
  req.once("close", () => {
    clearInterval(keepalive);
    subscription.close();
  });
  return true;
}

function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  account: WebAccount,
  workspaceId: string,
  options: WebHarnessRequestOptions,
): true {
  if (!enforceWebMutationRequest(req, res, options.auth.publicBaseUrl)) return true;
  const result = options.service.cancel(account, workspaceId);
  if (result === "not-found") {
    sendWebJson(res, 404, { error: "Workspace not found" });
  } else if (result === "unavailable") {
    sendWebJson(res, 503, { error: "Web runtime unavailable" });
  } else {
    sendWebJson(res, 202, { status: result });
  }
  return true;
}

function readPrompt(value: unknown): {
  text: string;
  clientRequestId: string;
  mode: "prompt" | "followUp" | "steer";
} | null {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > MAX_PROMPT_TEXT_LENGTH ||
    typeof value.clientRequestId !== "string" ||
    value.clientRequestId.length === 0 ||
    value.clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH ||
    !["prompt", "followUp", "steer"].includes(typeof value.mode === "string" ? value.mode : "")
  ) {
    return null;
  }
  return {
    text: value.text,
    clientRequestId: value.clientRequestId,
    mode: value.mode as "prompt" | "followUp" | "steer",
  };
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
