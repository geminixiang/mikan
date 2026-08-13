/**
 * SPA dist server over the WebServer fallback seat (DSH frontend-static
 * pattern): serves a built frontend directory with traversal protection,
 * SPA routing (any miss → index.html with 200), and index-tap injection on
 * every index response.
 */

import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import type { WebServer } from "./webserver.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory.
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (index-tap injection).
 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  distRoot: string,
  distIndex: string,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)));
  // Traversal rejection: the target must be distRoot itself (`/`) or stay
  // under it. `sep`, not '/': resolve() emits backslash paths on Windows.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const serveIndex = async (): Promise<void> => {
    const body = await renderIndex();
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(body);
  };
  if (target === distRoot || target === distIndex) {
    await serveIndex();
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // Miss (ENOENT/EISDIR) falls back to index.html with 200 (SPA routing).
    await serveIndex();
  }
}

export interface StaticFallbackOptions {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string;
  /** The WebServer whose fallback seat to claim. */
  webServer: WebServer;
}

/**
 * Claim the fallback seat and serve the dist. The returned disposer releases
 * the seat. Every index response runs through the registered index taps.
 */
export function registerStaticFallback(options: StaticFallbackOptions): () => void {
  const { webServer, distIndex } = options;
  const distRoot = dirname(distIndex);
  const renderIndex = async (): Promise<string> =>
    webServer.applyIndexTaps(await readFile(distIndex, "utf8"));
  return webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const rawPath = new URL(req.url ?? "/", "http://localhost").pathname;
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex);
  });
}
