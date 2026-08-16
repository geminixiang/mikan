import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileVaultManager } from "../vault/index.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { startWebServer } from "../web/server.js";

let dir: string;
let server: Server;
let url: string;

async function waitForListening(value: Server): Promise<void> {
  if (value.listening) return;
  await new Promise<void>((resolve) => value.once("listening", resolve));
}

function baseUrl(value: Server): string {
  const address = value.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  dir = join(tmpdir(), `mikan-web-app-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><title>mikan</title><div id="root"></div>',
  );
  writeFileSync(join(dir, "assets", "index-abc123.js"), "globalThis.mikan = true;");
  server = startWebServer({
    port: 0,
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(dir),
    notify: async () => {},
    webApp: { assetDir: dir },
  });
  await waitForListening(server);
  url = baseUrl(server);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(dir, { recursive: true, force: true });
});

describe("formal Web application serving", () => {
  test("serves root and workspace routes through the SPA with security headers", async () => {
    for (const path of ["/", "/w/wsp_example"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
      expect(await response.text()).toContain("<title>mikan</title>");
    }
  });

  test("serves hashed assets immutably with GET and HEAD", async () => {
    const asset = await fetch(`${url}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("globalThis.mikan = true;");

    const head = await fetch(`${url}/assets/index-abc123.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("globalThis.mikan = true;".length));
    expect(await head.text()).toBe("");
  });

  test("does not swallow APIs, auth, legacy routes, missing assets, or traversal", async () => {
    for (const path of [
      "/api/unknown",
      "/auth/unknown",
      "/admin/unknown",
      "/session/unknown",
      "/assets/missing.js",
      "/assets/%2e%2e%2findex.html",
      "/assets/%5cindex.html",
    ]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  test("keeps the formal app disabled when no asset bundle is configured", async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = startWebServer({
      port: 0,
      linkTokenStore: new InMemoryLinkTokenStore(),
      vaultManager: new FileVaultManager(dir),
      notify: async () => {},
    });
    await waitForListening(server);
    url = baseUrl(server);

    const response = await fetch(url);
    expect(response.status).toBe(404);
  });
});
