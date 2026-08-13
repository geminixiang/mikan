/**
 * @geminixiang/mikan-web-host — Web host seam for mikan: a node:http server
 * plus route registries (exact / prefix / upgrade), a single fallback seat,
 * and index transform taps. Modeled on DSH's @deepseek-ai/dsh-host-webserver,
 * minus the Cordis service layer: this package knows no harness concepts and
 * serves no files; the composing daemon (src/web/server.ts) registers routes
 * and the frontend-static equivalent claims the fallback seat.
 *
 * One deliberate adaptation: route handlers return `boolean | void`.
 * `true`/`undefined` means the handler owns the response; `false` means "not
 * mine" and dispatch falls through to the next candidate — the existing mikan
 * portal handlers (handleAdminRequest, handleSessionViewRequest, the login
 * handler, …) already use exactly this boolean contract, so they port without
 * wrappers.
 */

import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' matches p and p/<anything>. */
export type WebRouteKind = "exact" | "prefix";

/**
 * One named route registration. The handler owns the response only when it
 * returns `true` (or `undefined`); returning `false` declines and dispatch
 * continues to the next candidate.
 */
export interface WebRoute {
  kind: WebRouteKind;
  /** Absolute pathname, no trailing slash. */
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => boolean | void | Promise<boolean | void>;
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

/** The fallback seat handler: answers every request no named route claims. */
export type WebFallbackHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface WebServerListenOptions {
  port: number;
  host?: string;
  /** Invoked for per-request dispatch failures (the response is still 500'd). */
  onRequestError?: (req: IncomingMessage, err: unknown) => void;
}

/**
 * The browser HTTP carrier. Dispatch order: exact-table hit first, then
 * longest-prefix-wins over the prefix table; a candidate that returns `false`
 * falls through; if nothing handles the request the fallback seat (if claimed)
 * answers, else 404.
 */
export class WebServer {
  private readonly exact = new Map<string, WebRoute>();
  private readonly prefixes = new Map<string, WebRoute>();
  private readonly upgrades = new Map<string, WebUpgradeRoute>();
  private readonly upgradedSockets = new Set<Duplex>();
  private readonly indexTaps: Array<(html: string) => string> = [];
  private fallback: WebFallbackHandler | undefined;
  private server: HttpServer | undefined;
  private listenedPort: number | undefined;

  /** The listening port (the OS-assigned value when the configured port is 0). */
  get port(): number | undefined {
    return this.listenedPort;
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns
   * are a composition-level contract.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === "exact" ? this.exact : this.prefixes;
    if (table.has(route.path)) {
      throw new Error(`web-host: duplicate ${route.kind} route "${route.path}"`);
    }
    table.set(route.path, route);
    return () => {
      table.delete(route.path);
    };
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   * @returns the disposer removing the route.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`web-host: duplicate upgrade route "${route.path}"`);
    }
    this.upgrades.set(route.path, route);
    return () => {
      this.upgrades.delete(route.path);
    };
  }

  /**
   * Claim the fallback seat: the handler answering every request no named
   * route matches (the static-dist server in the composed web). One owner
   * only — a second registration throws.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebFallbackHandler): () => void {
    if (this.fallback !== undefined) {
      throw new Error("web-host: fallback already registered");
    }
    this.fallback = handler;
    return () => {
      this.fallback = undefined;
    };
  }

  /**
   * Register an index.html transform, applied to every index response
   * ({@link applyIndexTaps}) in registration order.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform);
    return () => {
      const at = this.indexTaps.indexOf(transform);
      if (at !== -1) this.indexTaps.splice(at, 1);
    };
  }

  /**
   * Run an index.html body through the registered taps in registration order.
   * @param html - the raw index.html body.
   * @returns the transformed body.
   */
  applyIndexTaps(html: string): string {
    let out = html;
    for (const transform of this.indexTaps) out = transform(out);
    return out;
  }

  /**
   * Start listening. The returned server has already bound the socket; the
   * `error` event and connection lifecycle remain the caller's.
   */
  async listen(options: WebServerListenOptions): Promise<HttpServer> {
    const server = createServer((req, res) => {
      void this.dispatch(req, res).catch((err: unknown) => {
        // Per-request failures must never take the process down.
        options.onRequestError?.(req, err);
        const message = err instanceof Error ? err.message : String(err);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      });
    });
    server.on("upgrade", (req, socket, head) => {
      const onError = (error: Error): void => {
        socket.destroy();
        void error;
      };
      socket.on("error", onError);
      socket.once("close", () => {
        socket.off("error", onError);
        this.upgradedSockets.delete(socket);
      });
      let route: WebUpgradeRoute | undefined;
      try {
        route = this.upgrades.get(pathnameOf(req.url));
      } catch {
        socket.destroy();
        return;
      }
      if (route === undefined) {
        socket.destroy();
        return;
      }
      this.upgradedSockets.add(socket);
      Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
        socket.destroy();
        void error;
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        server.on("error", (err) => {
          // Logged by the owning daemon; kept silent here to stay dependency-free.
          void err;
        });
        this.listenedPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    this.server = server;
    return server;
  }

  /** Stop the server and close tracked connections (including upgraded sockets). */
  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    const serverClosed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    const upgradedClosed = [...this.upgradedSockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.destroy();
        }),
    );
    await Promise.all([serverClosed, ...upgradedClosed]);
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawPath = pathnameOf(req.url);
    const candidates = this.matchCandidates(rawPath);
    for (const route of candidates) {
      const handled = await route.handler(req, res);
      if (handled !== false) return;
    }
    const fallback = this.fallback;
    if (fallback !== undefined) {
      await fallback(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  }

  /**
   * Dispatch candidates for one pathname: the exact-table entry first, then
   * prefix routes in longest-prefix order (a candidate that declines falls
   * through to the next).
   */
  private matchCandidates(pathname: string): WebRoute[] {
    const exact = this.exact.get(pathname);
    const prefixes: WebRoute[] = [];
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
      prefixes.push(route);
    }
    prefixes.sort((a, b) => b.path.length - a.path.length);
    return exact === undefined ? prefixes : [exact, ...prefixes];
  }
}

/** Pathname of a request URL; node:http always sets `req.url` on server requests. */
function pathnameOf(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}
