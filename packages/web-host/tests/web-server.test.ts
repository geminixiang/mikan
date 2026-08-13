import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server as HttpServer } from "node:http";
import { WebServer } from "../src/index.js";

describe("WebServer", () => {
  let server: WebServer;
  let http: HttpServer;
  let base: string;

  beforeEach(async () => {
    server = new WebServer();
    http = await server.listen({ port: 0, host: "127.0.0.1" });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("routes exact paths", async () => {
    server.register({
      kind: "exact",
      path: "/health",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("declining handlers fall through; the next candidate answers", async () => {
    const calls: string[] = [];
    server.register({ kind: "prefix", path: "/admin", handler: () => false });
    server.register({
      kind: "prefix",
      path: "/session",
      handler: (_req, res) => {
        calls.push("/session");
        res.writeHead(200);
        res.end();
      },
    });
    const res = await fetch(`${base}/session/message`);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["/session"]);
  });

  it("longest prefix wins", async () => {
    let hit = "";
    server.register({
      kind: "prefix",
      path: "/session",
      handler: (_req, res) => {
        hit = "short";
        res.writeHead(200);
        res.end();
      },
    });
    server.register({
      kind: "prefix",
      path: "/session/stream",
      handler: (_req, res) => {
        hit = "long";
        res.writeHead(200);
        res.end();
      },
    });
    await fetch(`${base}/session/stream?token=x`);
    expect(hit).toBe("long");
  });

  it("prefix does not match a sibling name", async () => {
    server.register({ kind: "prefix", path: "/session", handler: () => true });
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(404);
  });

  it("fallback seat answers unmatched requests with index.html (SPA routing)", async () => {
    server.registerFallback((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><title>index</title>");
    });
    const res = await fetch(`${base}/any/deep/path`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("index");
  });

  it("404 without a fallback seat", async () => {
    const res = await fetch(`${base}/missing`);
    expect(res.status).toBe(404);
  });

  it("duplicate registrations throw", () => {
    const fresh = new WebServer();
    fresh.register({ kind: "exact", path: "/health", handler: () => true });
    expect(() => fresh.register({ kind: "exact", path: "/health", handler: () => true })).toThrow(
      /duplicate/,
    );
  });

  it("applies index taps in registration order", () => {
    const fresh = new WebServer();
    fresh.tapIndex((html) =>
      html.replace("</head>", "<script>window.__MIKAN_BOOT__={}</script></head>"),
    );
    fresh.tapIndex((html) => html.replace("<title>", "<title>mikan "));
    const out = fresh.applyIndexTaps(
      "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>",
    );
    expect(out).toContain("window.__MIKAN_BOOT__");
    expect(out).toContain("<title>mikan x</title>");
  });

  it("disposers remove registrations", async () => {
    const dispose = server.register({
      kind: "exact",
      path: "/health",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    dispose();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(404);
  });

  it("handlers that throw answer 500 without killing the process", async () => {
    server.register({
      kind: "exact",
      path: "/boom",
      handler: () => {
        throw new Error("boom");
      },
    });
    const boomResponse = await fetch(`${base}/boom`);
    expect(boomResponse.status).toBe(500);
    const body = await boomResponse.json();
    expect(body.error).toBe("boom");
    // The server is still alive.
    server.register({
      kind: "exact",
      path: "/health",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end();
      },
    });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
