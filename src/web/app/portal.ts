import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WEB_APP_DIR = fileURLToPath(new URL("../../web-app", import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; style-src 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export interface WebAppRequestOptions {
  readonly assetDir?: string;
}

/** Serves the formal SPA without intercepting API, auth, or legacy portal routes. */
export function handleWebAppRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: WebAppRequestOptions = {},
): boolean {
  if ((req.method !== "GET" && req.method !== "HEAD") || isReservedRoute(url.pathname)) {
    return false;
  }

  const assetDir = resolve(options.assetDir ?? DEFAULT_WEB_APP_DIR);
  const requested = resolveAssetPath(assetDir, url.pathname);
  if (!requested) return false;
  if (requested.kind === "asset") {
    if (!isRegularFile(requested.path)) return false;
    sendFile(req, res, requested.path, true);
    return true;
  }

  const index = join(assetDir, "index.html");
  if (!isRegularFile(index)) return false;
  sendFile(req, res, index, false);
  return true;
}

function resolveAssetPath(
  assetDir: string,
  pathname: string,
): { kind: "asset" | "app"; path: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  if (pathname.startsWith("/assets/") || decoded.startsWith("/assets/")) {
    if (!decoded.startsWith("/assets/") || hasDotSegment(decoded)) return null;
    const path = resolve(assetDir, `.${decoded}`);
    const inside = relative(assetDir, path);
    if (inside.startsWith("..") || inside === "") return null;
    return { kind: "asset", path };
  }
  return { kind: "app", path: join(assetDir, "index.html") };
}

function hasDotSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  immutable: boolean,
): void {
  const size = statSync(path).size;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
}

function isReservedRoute(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/admin" ||
    pathname === "/link" ||
    pathname === "/login" ||
    pathname === "/session" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/github/") ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/session/")
  );
}

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
