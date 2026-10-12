import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as log from "../../../log.js";
import type { OfficeDesktop } from "../../../sandbox/desktop.js";
import type { DesktopTokenCreateOptions } from "../../../types.js";
import { errorMessage } from "../../../unknown-values.js";
import { InMemoryTokenStore } from "../token-store.js";
import { jsonResponse, readJsonBody } from "../portal-shell.js";
import { renderDesktopPage } from "./page.js";
import type { DesktopToken } from "./types.js";

const DESKTOP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const NOVNC_PREFIX = "/desktop/novnc/";
const NOVNC_DIRS = ["core", "vendor"];

export interface DesktopWebOptions {
  tokenStore: InMemoryDesktopTokenStore;
  desktop: Pick<OfficeDesktop, "start" | "status" | "setBrowserOwner" | "connect">;
}

export class InMemoryDesktopTokenStore extends InMemoryTokenStore<DesktopToken> {
  create(options: DesktopTokenCreateOptions): DesktopToken {
    return this.createRecord(DESKTOP_TOKEN_TTL_MS, {
      platform: options.platform,
      platformUserId: options.platformUserId,
      containerKey: options.office.key,
    });
  }
}

const novncRoot = realpathSync(
  dirname(dirname(fileURLToPath(import.meta.resolve("@novnc/novnc")))),
);

function novncFile(pathname: string): string | undefined {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(NOVNC_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!NOVNC_DIRS.some((dir) => relative.startsWith(`${dir}/`))) return undefined;
  if (extname(relative) !== ".js") return undefined;
  const file = join(novncRoot, relative);
  if (!file.startsWith(novncRoot + sep) || !existsSync(file)) return undefined;
  return realpathSync(file).startsWith(novncRoot + sep) ? file : undefined;
}

function tokenOf(store: InMemoryDesktopTokenStore | undefined, url: URL): DesktopToken | undefined {
  const raw = url.searchParams.get("token");
  return raw ? store?.peek(raw) : undefined;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(
    "This desktop link is invalid or has expired. Ask for a new one with the desktop command.",
  );
}

export async function handleDesktopRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DesktopWebOptions | undefined,
): Promise<boolean> {
  if (!url.pathname.startsWith("/desktop")) return false;
  if (url.pathname !== "/desktop" && !url.pathname.startsWith("/desktop/")) return false;

  if (req.method === "GET" && url.pathname.startsWith(NOVNC_PREFIX)) {
    const file = novncFile(url.pathname);
    if (!file) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(readFileSync(file));
    return true;
  }

  const token = tokenOf(options?.tokenStore, url);
  if (!options || !token) {
    notFound(res);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/desktop") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(renderDesktopPage());
    return true;
  }

  if (url.pathname === "/desktop/control" && (req.method === "GET" || req.method === "POST")) {
    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req, res, 1024);
        if (!body) return true;
        if (body.owner !== "agent" && body.owner !== "user") {
          jsonResponse(res, 400, { error: "owner must be agent or user" });
          return true;
        }
        await options.desktop.setBrowserOwner(token.containerKey, body.owner);
      }
      const status = await options.desktop.status(token.containerKey);
      jsonResponse(res, 200, { owner: status.control, running: status.display !== undefined });
    } catch (error) {
      log.logWarning("Desktop control failed", errorMessage(error));
      jsonResponse(res, 409, { error: "The desktop is not running. Ask for a new link." });
    }
    return true;
  }

  res.writeHead(404);
  res.end();
  return true;
}

const REFUSAL_GRACE_MS = 1_000;

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  setTimeout(() => socket.destroy(), REFUSAL_GRACE_MS).unref();
}

function upstreamRequest(req: IncomingMessage): string {
  const lines = ["GET / HTTP/1.1", "Host: 127.0.0.1"];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? "";
    if (/^(host|origin|cookie|authorization)$/i.test(name)) continue;
    lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ""}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export async function handleDesktopUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  options: DesktopWebOptions | undefined,
): Promise<boolean> {
  if (url.pathname !== "/desktop/ws") return false;
  const token = tokenOf(options?.tokenStore, url);
  if (!options || !token) {
    refuse(socket, 403, "Forbidden");
    return true;
  }
  let started: Awaited<ReturnType<OfficeDesktop["start"]>>;
  try {
    started = await options.desktop.start(token.containerKey);
  } catch (error) {
    log.logWarning("Desktop start failed", errorMessage(error));
    refuse(socket, 503, "Service Unavailable");
    return true;
  }
  if (started !== "ready") {
    refuse(socket, 409, "Conflict");
    return true;
  }
  if (socket.destroyed) return true;
  const stream = options.desktop.connect(token.containerKey);
  const expiry = setTimeout(() => close(), Math.max(0, token.expiresAt - Date.now()));
  expiry.unref();
  function close() {
    clearTimeout(expiry);
    stream.close();
    socket.destroy();
  }
  stream.input.on("error", close);
  stream.output.on("error", close);
  stream.process.once("exit", close);
  socket.on("error", close);
  socket.on("close", close);
  stream.input.write(upstreamRequest(req));
  if (head.length > 0) stream.input.write(head);
  socket.pipe(stream.input);
  stream.output.pipe(socket);
  return true;
}
