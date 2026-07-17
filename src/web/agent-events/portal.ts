import type { IncomingMessage, ServerResponse } from "http";
import { addAgentEventStreamClient } from "../../agent-events.js";
import { readEnv } from "../../utils/env.js";

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
