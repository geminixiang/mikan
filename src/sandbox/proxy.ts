import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { SecretProxyHandle } from "./types.js";

type HeaderRules = Record<string, Record<string, string>>;

const LOOPBACK_HOST = "127.0.0.1";

export async function startSecretInjectionProxy(
  rules: HeaderRules,
  host = LOOPBACK_HOST,
): Promise<SecretProxyHandle> {
  const server = createServer((request, response) => handleHttpRequest(request, response, rules));
  server.on("connect", (_request, clientSocket: Socket) => {
    clientSocket.end(
      "HTTP/1.1 501 Not Implemented\r\n" +
        "Connection: close\r\n\r\n" +
        "MIKAN_PROXY_INJECT_HEADERS supports HTTP proxy requests only; HTTPS CONNECT cannot be modified.\n",
    );
  });

  await listen(server, host);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Secret proxy did not bind a TCP port");
  return {
    url: `http://${host}:${address.port}`,
    close: () => close(server),
  };
}

export function parseProxyHeaderRules(env?: Record<string, string>): HeaderRules | undefined {
  const raw = env?.MIKAN_PROXY_INJECT_HEADERS;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!isHeaderRules(parsed)) throw new Error("Invalid MIKAN_PROXY_INJECT_HEADERS JSON");
  return parsed;
}

export function stripProxySecretEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  delete next.MIKAN_PROXY_INJECT_HEADERS;
  return next;
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  rules: HeaderRules,
): void {
  const target = parseRequestTarget(request);
  if (!target) {
    response.writeHead(400);
    response.end("proxy requires absolute-form request target");
    return;
  }
  for (const [key, value] of Object.entries(rules[target.host] ?? {})) {
    request.headers[key.toLowerCase()] = value;
  }

  const upstream = createServerlessRequest(target, request, response);
  request.pipe(upstream);
}

function createServerlessRequest(target: URL, request: IncomingMessage, response: ServerResponse) {
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = requestImpl(
    target,
    { method: request.method, headers: request.headers },
    (upstreamResponse: IncomingMessage) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error: Error) => {
    response.writeHead(502);
    response.end(error.message);
  });
  return upstream;
}

function parseRequestTarget(request: IncomingMessage): URL | undefined {
  try {
    if (!request.url?.startsWith("http://") && !request.url?.startsWith("https://"))
      return undefined;
    return new URL(request.url);
  } catch {
    return undefined;
  }
}

function isHeaderRules(value: unknown): value is HeaderRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (headers) =>
      headers &&
      typeof headers === "object" &&
      !Array.isArray(headers) &&
      Object.values(headers).every((header) => typeof header === "string"),
  );
}

function listen(server: Server, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
