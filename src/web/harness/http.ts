import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HarnessProtocolError,
  parseHarnessCommand,
  type HarnessCursor,
  type HarnessErrorBody,
  type HarnessErrorCode,
  type HarnessPrincipal,
} from "@geminixiang/mikan-harness-web-contract";
import * as log from "../../log.js";
import { enforceJsonCsrf, readJsonBody } from "../portal-shell.js";
import type { InMemoryWebSessionStore } from "../login/session-store.js";
import { HarnessHostError } from "./host.js";
import type { HarnessHost } from "./types.js";

const COMMAND_BODY_LIMIT = 128 * 1024;
const HEARTBEAT_MS = 15_000;

interface HarnessStreamAccess {
  principal: HarnessPrincipal;
  sessions: InMemoryWebSessionStore;
}

export function createHarnessRequestHandler(
  host: HarnessHost,
  sessions: InMemoryWebSessionStore,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/api/harness/")) return false;
    const principal = authenticate(req, res, sessions);
    if (!principal) return true;

    try {
      if (url.pathname === "/api/harness/bootstrap") {
        if (req.method !== "GET") return methodNotAllowed(res);
        const officeKey = url.searchParams.get("office")?.trim() || undefined;
        const bootstrap = await host.bootstrap(principal, officeKey);
        writeJson(res, 200, bootstrap);
        return true;
      }

      if (url.pathname === "/api/harness/command") {
        if (req.method !== "POST") return methodNotAllowed(res);
        if (!enforceJsonCsrf(req, res)) return true;
        const body = await readJsonBody(req, res, COMMAND_BODY_LIMIT);
        if (body === null) return true;
        const command = parseHarnessCommand(body);
        const result = await host.execute(principal, command);
        writeJson(res, 200, result);
        return true;
      }

      if (url.pathname === "/api/harness/events") {
        if (req.method !== "GET") return methodNotAllowed(res);
        return serveEvents(req, res, url, { principal, sessions }, host);
      }

      writeError(res, 404, "not-found", "Harness endpoint not found");
      return true;
    } catch (error) {
      handleError(res, error);
      return true;
    }
  };
}

function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: InMemoryWebSessionStore,
): HarnessPrincipal | undefined {
  const session = sessions.getSessionFromCookie(req.headers.cookie);
  if (!session) {
    writeError(res, 401, "unauthenticated", "Authentication required");
    return undefined;
  }
  return { id: session.oauthIdentity, displayName: session.oauthDisplayName };
}

function serveEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  access: HarnessStreamAccess,
  host: HarnessHost,
): true {
  const cursor = parseCursor(req, url);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const subscription = host.subscribe(access.principal, cursor, (envelope) => {
    res.write(`id: ${envelope.cursor.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`);
  });
  if (subscription.kind === "reset") {
    res.write(`event: reset\ndata: ${JSON.stringify(subscription.cursor)}\n\n`);
    res.end();
    return true;
  }

  const heartbeat = setInterval(() => {
    if (!access.sessions.getSessionFromCookie(req.headers.cookie)) {
      res.write("event: reset\ndata: {}\n\n");
      res.end();
      return;
    }
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    subscription.dispose();
  };
  res.once("close", dispose);
  return true;
}

function parseCursor(req: IncomingMessage, url: URL): HarnessCursor {
  const epoch = url.searchParams.get("epoch")?.trim();
  const queryText = url.searchParams.get("after")?.trim();
  const querySequence = queryText ? Number(queryText) : Number.NaN;
  const eventIdHeader = req.headers["last-event-id"];
  const eventId = Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader;
  const resumedSequence = eventId?.trim() ? Number(eventId) : querySequence;
  const sequence = Math.max(querySequence, resumedSequence);
  if (!epoch || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new HarnessProtocolError("A valid event cursor is required");
  }
  return { epoch, sequence };
}

function handleError(res: ServerResponse, error: unknown): void {
  if (error instanceof HarnessHostError) {
    writeError(res, statusFor(error.code), error.code, error.message);
    return;
  }
  if (error instanceof HarnessProtocolError) {
    writeError(res, 400, "invalid", error.message);
    return;
  }
  log.logWarning(
    "Harness web request failed",
    error instanceof Error ? error.message : String(error),
  );
  writeError(res, 500, "unavailable", "Harness request failed");
}

function statusFor(code: HarnessErrorCode): number {
  switch (code) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "invalid":
      return 400;
    case "conflict":
      return 409;
    case "unavailable":
      return 503;
  }
}

function methodNotAllowed(res: ServerResponse): true {
  writeError(res, 405, "invalid", "Method not allowed");
  return true;
}

function writeError(
  res: ServerResponse,
  status: number,
  code: HarnessErrorCode,
  message: string,
): void {
  const body: HarnessErrorBody = { error: { code, message } };
  writeJson(res, status, body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
