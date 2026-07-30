import type { IncomingMessage, ServerResponse } from "node:http";
import { readEnv } from "./env-manifest.js";
import type { AgentEventEnvelope } from "./types.js";

const clients = new Set<ServerResponse>();
let nextEventId = 1;

export function emitAgentEvent(event: AgentEventEnvelope): void {
  const payload = `id: ${nextEventId++}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function addAgentEventStreamClient(res: ServerResponse): () => void {
  clients.add(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`: connected\n\n`);

  const keepAlive = setInterval(() => res.write(`: keepalive\n\n`), 25_000);
  keepAlive.unref();

  return () => {
    clearInterval(keepAlive);
    clients.delete(res);
    res.end();
  };
}

/** The `/api/agent-events/stream` SSE endpoint (optionally token-gated). */
export function handleAgentEventsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (req.method !== "GET" || url.pathname !== "/api/agent-events/stream") {
    return false;
  }

  const expectedToken = readEnv("AGENT_EVENTS_TOKEN");
  const auth = req.headers.authorization ?? "";
  const queryToken = url.searchParams.get("token") ?? "";
  if (expectedToken && auth !== `Bearer ${expectedToken}` && queryToken !== expectedToken) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized");
    return true;
  }

  const cleanup = addAgentEventStreamClient(res);
  req.on("close", cleanup);
  return true;
}
