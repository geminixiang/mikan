import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { BlockList } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createWebFetchTool,
  isNonPublicAddress,
  WEB_FETCH_TOOL,
} from "../harness/tools/web-fetch.js";
import { runTestTool } from "./tool-api.js";

const PAGE = `<html><head><title>Example Releases</title><script>var hidden = 1</script></head><body>
<nav><a href="/menu">menu</a></nav><main><h1>Releases</h1><p>Latest: <a href="/v2.4.0">v2.4.0</a> on 2026-10-07</p></main></body></html>`;

let publicServer: Server;
let privateServer: Server;
let publicBase = "";
let privateBase = "";
let privateHits = 0;
const cwd = mkdtempSync(join(tmpdir(), "mikan-web-fetch-"));

function listen(handler: RequestListener, host: string): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, host, () => resolve(server)));
}

function port(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

const onlyIpv6Loopback = new BlockList();
onlyIpv6Loopback.addAddress("::1", "ipv6");

beforeAll(async () => {
  privateServer = await listen((_req, res) => {
    privateHits += 1;
    res.end("internal secret");
  }, "::1");
  privateBase = `http://[::1]:${port(privateServer)}`;
  publicServer = await listen((req, res) => {
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(PAGE);
    }
    if (req.url === "/old") {
      res.writeHead(301, { location: "/page" });
      return res.end();
    }
    if (req.url === "/to-private") {
      res.writeHead(302, { location: `${privateBase}/meta-data` });
      return res.end();
    }
    if (req.url === "/api.json") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ latest: "2.4.0" }));
    }
    if (req.url === "/big.json") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          latest: "9.9.9",
          versions: Array.from({ length: 5000 }, (_, i) => `1.0.${i}`),
        }),
      );
    }
    if (req.url === "/file.zip") {
      res.setHeader("content-type", "application/zip");
      return res.end("PK");
    }
    res.statusCode = 404;
    return res.end("not here");
  }, "127.0.0.1");
  publicBase = `http://127.0.0.1:${port(publicServer)}`;
});

afterAll(() => {
  publicServer.close();
  privateServer.close();
  rmSync(cwd, { recursive: true, force: true });
});

async function fetchText(url: string, blocked = onlyIpv6Loopback) {
  const result = await runTestTool(
    createWebFetchTool({ blocked }),
    { label: "Read", url },
    { env: new NodeExecutionEnv({ cwd }) },
  );
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("web_fetch tool", () => {
  test("takes a label and a url", () => {
    const tool = createWebFetchTool();
    expect(tool.name).toBe(WEB_FETCH_TOOL);
    expect(tool.parameters).toMatchObject({ required: ["label", "url"] });
  });

  test("returns HTML as Markdown without scripts or navigation, keeping links", async () => {
    const text = await fetchText(`${publicBase}/page`);
    expect(text).toContain(`[v2.4.0](${publicBase}/v2.4.0) on 2026-10-07`);
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("menu");
  });

  test("follows redirects and reports the final url", async () => {
    expect(await fetchText(`${publicBase}/old`)).toContain(`Redirected to ${publicBase}/page`);
  });

  test("returns JSON as it is", async () => {
    expect(await fetchText(`${publicBase}/api.json`)).toContain('{"latest":"2.4.0"}');
  });

  test("bounds a large result and saves the whole one in the workspace", async () => {
    const text = await fetchText(`${publicBase}/big.json`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
    expect(text).toContain('"latest":"9.9.9"');
    const spillPath = /Full result: (\S+)/.exec(text)?.[1];
    expect(spillPath?.startsWith(cwd)).toBe(true);
    expect(JSON.parse(readFileSync(spillPath!, "utf8")).versions).toHaveLength(5000);
  });

  test("refuses a non-public address at connect time", async () => {
    privateHits = 0;
    await expect(fetchText(`${privateBase}/meta-data`)).rejects.toThrow(
      /web_fetch refuses non-public address ::1/,
    );
    expect(privateHits).toBe(0);
  });

  test("refuses a redirect to a non-public address", async () => {
    privateHits = 0;
    await expect(fetchText(`${publicBase}/to-private`)).rejects.toThrow(
      /web_fetch refuses non-public address ::1/,
    );
    expect(privateHits).toBe(0);
  });

  test("blocks loopback by default", async () => {
    await expect(
      runTestTool(createWebFetchTool(), { label: "Read", url: `${publicBase}/page` }),
    ).rejects.toThrow(/web_fetch refuses non-public address 127\.0\.0\.1/);
  });

  test.each([
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["224.0.0.1", true],
    ["::1", true],
    ["::", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:192.168.1.1", true],
    ["93.184.216.34", false],
    ["2606:2800:220:1:248:1893:25c8:1946", false],
    ["::ffff:93.184.216.34", false],
  ])("treats %s as non-public: %s", (address, blocked) => {
    expect(isNonPublicAddress(address)).toBe(blocked);
  });

  test("refuses URLs that are not http or https", async () => {
    await expect(fetchText("file:///etc/passwd")).rejects.toThrow(
      "web_fetch supports only http and https URLs, not file:",
    );
  });

  test("reports the HTTP status of a failed response", async () => {
    await expect(fetchText(`${publicBase}/missing`)).rejects.toThrow(
      `web_fetch got HTTP 404 for ${publicBase}/missing`,
    );
  });

  test("refuses binary content types", async () => {
    await expect(fetchText(`${publicBase}/file.zip`)).rejects.toThrow(
      "Unsupported content type application/zip",
    );
  });
});
