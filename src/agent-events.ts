import type { ServerResponse } from "http";
import type { AgentEventEnvelope } from "./types.js";

const clients = new Set<ServerResponse>();
let nextEventId = 1;

export function emitAgentEvent(event: AgentEventEnvelope): void {
  const payload = `id: ${nextEventId++}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

export function addAgentEventStreamClient(res: ServerResponse): () => void {
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
