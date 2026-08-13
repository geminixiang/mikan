import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server as HttpServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebServer, registerStaticFallback, serveStatic } from "../src/index.js";
import { injectBootManifest, graphRev, type WebBootGraph } from "../src/boot-manifest.js";
import type { ServerResponse } from "node:http";

describe("serveStatic / registerStaticFallback", () => {
  let dir: string;
  let distRoot: string;
  let webServer: WebServer;
  let http: HttpServer;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "web-host-static-"));
    distRoot = join(dir, "dist");
    mkdirSync(distRoot, { recursive: true });
    writeFileSync(
      join(distRoot, "index.html"),
      "<!DOCTYPE html><html><head></head><body></body></html>",
    );
    writeFileSync(join(distRoot, "app.js"), "console.log('hi')");
    writeFileSync(join(distRoot, "style.css"), "body{}");
    webServer = new WebServer();
    http = await webServer.listen({ port: 0, host: "127.0.0.1" });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await webServer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves index.html at / with 200 and correct content type", async () => {
    registerStaticFallback({ webServer, distIndex: join(distRoot, "index.html") });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves static assets with their MIME types", async () => {
    registerStaticFallback({ webServer, distIndex: join(distRoot, "index.html") });
    const js = await fetch(`${base}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toBe("console.log('hi')");
    const css = await fetch(`${base}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("SPA routing: any miss serves index.html with 200", async () => {
    registerStaticFallback({ webServer, distIndex: join(distRoot, "index.html") });
    const res = await fetch(`${base}/session/abc?token=x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!DOCTYPE html>");
  });

  it("neutralizes path traversal: files outside the dist root never leak", async () => {
    registerStaticFallback({ webServer, distIndex: join(distRoot, "index.html") });
    // A secret file just outside the dist root. URL parsing normalizes `..`
    // segments before serveStatic runs, so a traversal attempt must not
    // return its contents (and the direct serveStatic guard is separately
    // unit-tested below).
    writeFileSync(join(dir, "outside.txt"), "TOP SECRET");
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("no bound address");
    const { connect } = await import("node:net");
    const { once } = await import("node:events");
    const socket = connect(address.port, "127.0.0.1");
    socket.write("GET /../outside.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    await once(socket, "close");
    expect(data).not.toContain("TOP SECRET");
  });

  it("rejects non-GET/HEAD on the fallback with 405", async () => {
    registerStaticFallback({ webServer, distIndex: join(distRoot, "index.html") });
    const res = await fetch(`${base}/app.js`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("applies index taps to every index response", async () => {
    webServer.tapIndex((html) =>
      html.replace("</head>", "<script>window.__MIKAN_BOOT__={}</script></head>"),
    );
    registerStaticFallback({ webServer, distIndex: join(distRoot, "index.html") });
    const res = await fetch(`${base}/`);
    expect(await res.text()).toContain("window.__MIKAN_BOOT__");
    const miss = await fetch(`${base}/any/path`);
    expect(await miss.text()).toContain("window.__MIKAN_BOOT__");
  });

  it("serveStatic writes 403 for traversal without touching the fs", async () => {
    const calls: string[] = [];
    const res = {
      statusCode: 0,
      writeHead(code: number) {
        res.statusCode = code;
      },
      end() {
        calls.push("end");
        return res;
      },
      write() {
        return true;
      },
      destroy() {},
    } as unknown as ServerResponse;
    await serveStatic(
      "/../etc/passwd",
      res,
      distRoot,
      join(distRoot, "index.html"),
      async () => "index",
    );
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual(["end"]);
  });
});

describe("boot manifest", () => {
  const graph: WebBootGraph = {
    rev: "abc",
    entries: [{ id: "app", url: "/assets/index-123.js", rev: "rev1", immediately: true }],
  };

  it("injects the graph as the first script in <head>", () => {
    const html = "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";
    const out = injectBootManifest(html, graph);
    expect(out.indexOf("window.__MIKAN_BOOT__")).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain('"id":"app"');
  });

  it("escapes < in the JSON to prevent script breakout", () => {
    const evil: WebBootGraph = {
      rev: "r",
      entries: [{ id: "</script><script>alert(1)</script>", url: "/u", rev: "v" }],
    };
    const out = injectBootManifest("<html><head></head></html>", evil);
    expect(out).not.toContain("</script><script>alert(1)");
    // Only `<` is escaped (sufficient: it closes no tag without a `>`).
    expect(out).toContain("\\u003c/script>");
  });

  it("prepends when there is no <head>", () => {
    const out = injectBootManifest("<body></body>", graph);
    expect(out.startsWith("<script>window.__MIKAN_BOOT__")).toBe(true);
  });

  it("graphRev is stable and content-sensitive", () => {
    const a = graphRev({ rev: "1", entries: [{ id: "x", url: "/u", rev: "v" }] });
    const b = graphRev({ rev: "1", entries: [{ id: "x", url: "/u", rev: "v" }] });
    const c = graphRev({ rev: "1", entries: [{ id: "x", url: "/u", rev: "DIFFERENT" }] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
