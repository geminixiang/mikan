import { describe, expect, test, vi } from "vitest";
import { createWebFetchTool, WEB_FETCH_TOOL } from "../harness/tools/web-fetch.js";
import type { WebFetchLookup } from "../harness/tools/types.js";

const PUBLIC: WebFetchLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const MIXED: WebFetchLookup = async () => [
  { address: "93.184.216.34", family: 4 },
  { address: "10.0.0.5", family: 4 },
];
const LOCALHOST_AWARE: WebFetchLookup = async (host) =>
  host === "localhost" ? [{ address: "127.0.0.1", family: 4 }] : PUBLIC(host);

function html(body: string): string {
  return `<html><head><title>Example Releases</title><script>var hidden = 1</script><style>p{}</style></head><body><nav>menu</nav><main><h1>Releases</h1>${body}</main></body></html>`;
}

function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route();
  });
}

async function call(tool: ReturnType<typeof createWebFetchTool>, args: Record<string, unknown>) {
  const result = await tool.execute("call-1", { label: "Read", ...args } as never, undefined);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("web_fetch tool", () => {
  test("requires a label and a url, and offers offset and find", () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe(WEB_FETCH_TOOL);
    expect(tool.parameters.required).toEqual(["label", "url"]);
    expect(Object.keys(tool.parameters.properties)).toEqual(["label", "url", "offset", "find"]);
  });

  test("returns readable page text without scripts, styles, or navigation, keeping links", async () => {
    const fetch = fakeFetch({
      "https://example.com/releases": () =>
        new Response(html('<p>Latest: <a href="/v2.4.0">v2.4.0</a> on 2026-10-07 &amp; more</p>'), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    const text = await call(createWebFetchTool({ fetch, lookup: PUBLIC }), {
      url: "https://example.com/releases",
    });
    expect(text).toContain("URL: https://example.com/releases");
    expect(text).toContain("Title: Example Releases");
    expect(text).toContain("[v2.4.0](https://example.com/v2.4.0) on 2026-10-07 & more");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("menu");
  });

  test.each([
    "http://127.0.0.1:8080/v1/models",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:3000/",
    "http://[::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "file:///etc/passwd",
  ])("refuses %s without sending a request", async (url) => {
    const fetch = fakeFetch({});
    await expect(
      call(createWebFetchTool({ fetch, lookup: LOCALHOST_AWARE }), { url }),
    ).rejects.toThrow(/private|loopback|link-local|http/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("refuses a public name that resolves to any private address", async () => {
    const fetch = fakeFetch({});
    await expect(
      call(createWebFetchTool({ fetch, lookup: MIXED }), { url: "https://rebind.example.com/" }),
    ).rejects.toThrow(/private/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("refuses at connect time when the name resolves differently than it did on the check", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => res.end("internal secret"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(
        call(createWebFetchTool({ lookup: PUBLIC }), { url: `http://localhost:${port}/` }),
      ).rejects.toThrow(
        /web_fetch failed for http:\/\/localhost:\d+\/: web_fetch refuses loopback/,
      );
    } finally {
      server.close();
    }
  });

  test("checks every redirect hop and stops at a private target", async () => {
    const fetch = fakeFetch({
      "https://example.com/go": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    });
    await expect(
      call(createWebFetchTool({ fetch, lookup: PUBLIC }), { url: "https://example.com/go" }),
    ).rejects.toThrow(/link-local/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("follows a public redirect and reports the final url", async () => {
    const fetch = fakeFetch({
      "https://example.com/old": () =>
        new Response(null, { status: 301, headers: { location: "/new" } }),
      "https://example.com/new": () =>
        new Response("plain body", { headers: { "content-type": "text/plain" } }),
    });
    const text = await call(createWebFetchTool({ fetch, lookup: PUBLIC }), {
      url: "https://example.com/old",
    });
    expect(text).toContain("URL: https://example.com/new");
    expect(text).toContain("plain body");
  });

  test("returns long content in windows and tells the model how to continue", async () => {
    const long = `${"x".repeat(30_000)}MARKER version 9.9.9`;
    const fetch = fakeFetch({
      "https://example.com/long": () =>
        new Response(long, { headers: { "content-type": "text/plain" } }),
    });
    const tool = createWebFetchTool({ fetch, lookup: PUBLIC });
    const first = await call(tool, { url: "https://example.com/long" });
    expect(first).toContain(`Showing characters 0-12000 of ${long.length}`);
    expect(first).toContain("offset=12000");
    expect(first).not.toContain("MARKER");
    const found = await call(tool, { url: "https://example.com/long", find: "marker" });
    expect(found).toContain("MARKER version 9.9.9");
    const missing = await call(tool, { url: "https://example.com/long", find: "absent" });
    expect(missing).toContain('"absent" was not found');
  });

  test("returns JSON as raw text", async () => {
    const body = JSON.stringify({ latest: "2.4.0", versions: ["1.0.0"] });
    const fetch = fakeFetch({
      "https://example.org/api.json": () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    });
    const text = await call(createWebFetchTool({ fetch, lookup: PUBLIC }), {
      url: "https://example.org/api.json",
    });
    expect(text).toContain(body);
  });

  test("reports the HTTP status of a failed response", async () => {
    const fetch = fakeFetch({
      "https://example.com/missing": () => new Response("not here", { status: 404 }),
    });
    await expect(
      call(createWebFetchTool({ fetch, lookup: PUBLIC }), { url: "https://example.com/missing" }),
    ).rejects.toThrow("HTTP 404 for https://example.com/missing");
  });

  test("refuses binary content types", async () => {
    const fetch = fakeFetch({
      "https://example.com/file.zip": () =>
        new Response("PK", { headers: { "content-type": "application/zip" } }),
    });
    await expect(
      call(createWebFetchTool({ fetch, lookup: PUBLIC }), { url: "https://example.com/file.zip" }),
    ).rejects.toThrow("Unsupported content type application/zip");
  });
});
