import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findMcpPreset, listMcpPresets, materializeMcpPreset } from "../harness/mcp.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { FileVaultManager } from "../vault/index.js";
import { handleAdminRequest, InMemoryAdminTokenStore } from "../adapters/web/admin/portal.js";
import type { AdminServices } from "../adapters/web/admin/types.js";

const CONVERSATION_ID = "C-MCP";
const ADDRESS = createOfficeAddress("slack", CONVERSATION_ID);

let base: string;
let stateDir: string;
let server: Server;
let origin: string;
let token: string;

function startServer(services: AdminServices): Promise<{ server: Server; origin: string }> {
  const instance = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleAdminRequest(req, res, url, services).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address() as AddressInfo;
      resolve({ server: instance, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(
    `${origin}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
  );
  return { status: response.status, body: await response.json() };
}

async function post(path: string, body: object): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

function globalSettings(): any {
  return JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"));
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "mikan-admin-mcp-"));
  stateDir = join(base, "state");
  const workspaceDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  const workspace = createWorkspace({ root: workspaceDir, stateDir });
  workspace.office(ADDRESS).ensure();
  process.env.MIKAN_STATE_DIR = stateDir;
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    }),
  );

  const adminTokenStore = new InMemoryAdminTokenStore();
  token = adminTokenStore.create({
    platform: "slack",
    platformUserId: "U1",
    conversationId: CONVERSATION_ID,
  }).token;
  const started = await startServer({
    vaultManager: new FileVaultManager(stateDir),
    linkTokenStore: { create: () => ({ token: "x", expiresAt: 0 }) } as never,
    adminTokenStore,
    workspace,
  });
  server = started.server;
  origin = started.origin;
});

afterEach(async () => {
  delete process.env.MIKAN_STATE_DIR;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe("MCP preset catalog", () => {
  test("contains reviewed, pinned recipes", () => {
    const presets = listMcpPresets();

    expect(presets.map((preset) => preset.id)).toEqual(["metabase"]);
    for (const preset of presets) {
      expect(JSON.stringify(preset.server)).not.toContain("@latest");
      expect(preset.sourceUrl).toMatch(/^https:\/\/github\.com\//);
    }
  });

  test("materializes a remote URL and API key", () => {
    const preset = findMcpPreset("metabase")!;

    expect(
      materializeMcpPreset(preset, {
        url: "https://metabase.example.com/api/metabase-mcp",
        "x-api-key": "mb_key_123",
      }),
    ).toEqual({
      url: "https://metabase.example.com/api/metabase-mcp",
      headers: { "x-api-key": "mb_key_123" },
    });
  });

  test("rejects missing credentials and invalid remote URLs", () => {
    expect(() => materializeMcpPreset(findMcpPreset("metabase")!, {})).toThrow(
      "Metabase MCP server URL is required",
    );
    expect(() =>
      materializeMcpPreset(findMcpPreset("metabase")!, {
        url: "metabase.example.com/api/metabase-mcp",
        "x-api-key": "mb_key_123",
      }),
    ).toThrow("Metabase MCP server URL must be a valid HTTP URL");
  });
});

describe("Admin MCP preset API", () => {
  test("lists presets with the two settings scopes", async () => {
    const response = await get(`/admin/api/mcp-servers?conversationId=${CONVERSATION_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.presets.map((preset: { id: string }) => preset.id)).toEqual(["metabase"]);
    expect(response.body.global).toEqual({});
    expect(response.body.conversation).toEqual({});
  });

  test("installs a Metabase preset with a redacted API key", async () => {
    const installed = await post("/admin/api/mcp-servers/mutate", {
      action: "install",
      scope: "global",
      presetId: "metabase",
      credentials: {
        url: "https://metabase.example.com/api/metabase-mcp",
        "x-api-key": "mb_key_123",
      },
      conversationId: CONVERSATION_ID,
    });

    expect(installed.status).toBe(200);
    expect(globalSettings().mcpServers.metabase).toEqual({
      url: "https://metabase.example.com/api/metabase-mcp",
      headers: { "x-api-key": "mb_key_123" },
    });

    const listed = await get(`/admin/api/mcp-servers?conversationId=${CONVERSATION_ID}`);
    expect(listed.body.global.metabase).toEqual({
      url: "https://metabase.example.com/api/metabase-mcp",
      envKeys: [],
      headerKeys: ["x-api-key"],
    });
    expect(JSON.stringify(listed.body.global)).not.toContain("mb_key_123");
  });

  test("rejects unknown presets and missing required credentials", async () => {
    const unknown = await post("/admin/api/mcp-servers/mutate", {
      action: "install",
      scope: "global",
      presetId: "unknown",
      credentials: {},
      conversationId: CONVERSATION_ID,
    });
    const missing = await post("/admin/api/mcp-servers/mutate", {
      action: "install",
      scope: "global",
      presetId: "metabase",
      credentials: {},
      conversationId: CONVERSATION_ID,
    });

    expect(unknown).toMatchObject({ status: 400, body: { error: "unknown MCP preset" } });
    expect(missing).toMatchObject({
      status: 400,
      body: { error: "Metabase MCP server URL is required" },
    });
    expect(globalSettings().mcpServers).toBeUndefined();
  });
});

function startFakeHttpMcpServer(): Promise<{ server: Server; url: string }> {
  const instance = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
      id?: string | number;
      method?: string;
    };
    if (req.headers.authorization !== "Bearer good-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "No API token provided" },
        }),
      );
      return;
    }
    if (message.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1.0.0" },
          }
        : {
            tools: [
              { name: "one", inputSchema: { type: "object" } },
              { name: "two", inputSchema: { type: "object" } },
            ],
          };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  return new Promise((resolve) => {
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address() as AddressInfo;
      resolve({ server: instance, url: `http://127.0.0.1:${address.port}/mcp` });
    });
  });
}

describe("Admin MCP import API", () => {
  test("imports a pasted mcpServers block, stores the normalized shape, and reports tools", async () => {
    const fake = await startFakeHttpMcpServer();
    try {
      const imported = await post("/admin/api/mcp-servers/mutate", {
        action: "import",
        scope: "global",
        json: JSON.stringify({
          mcpServers: {
            browser: {
              type: "http",
              url: fake.url,
              headers: { Authorization: "Bearer good-token" },
            },
          },
        }),
        conversationId: CONVERSATION_ID,
      });

      expect(imported.status).toBe(200);
      expect(imported.body.results).toEqual([{ name: "browser", tools: 2 }]);
      expect(globalSettings().mcpServers.browser).toEqual({
        url: fake.url,
        headers: { Authorization: "Bearer good-token" },
      });

      const tested = await post("/admin/api/mcp-servers/mutate", {
        action: "test",
        scope: "global",
        name: "browser",
        conversationId: CONVERSATION_ID,
      });
      expect(tested.body.results).toEqual([{ name: "browser", tools: 2 }]);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  test("keeps a bad entry on disk but surfaces the server's auth error, redacting the URL", async () => {
    const fake = await startFakeHttpMcpServer();
    try {
      const imported = await post("/admin/api/mcp-servers/mutate", {
        action: "import",
        scope: "global",
        json: JSON.stringify({
          mcpServers: { browser: { url: `${fake.url}?token=wrong-secret` } },
        }),
        conversationId: CONVERSATION_ID,
      });

      expect(imported.status).toBe(200);
      expect(imported.body.results).toHaveLength(1);
      expect(imported.body.results[0].name).toBe("browser");
      expect(imported.body.results[0].error).toContain("No API token provided");
      expect(JSON.stringify(imported.body)).not.toContain("wrong-secret");
      expect(globalSettings().mcpServers.browser.url).toBe(`${fake.url}?token=wrong-secret`);

      const listed = await get(`/admin/api/mcp-servers?conversationId=${CONVERSATION_ID}`);
      expect(listed.body.global.browser.url).toBe(`${fake.url}?token=<redacted>`);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  test("rejects legacy 'set' payloads and malformed JSON with a clear error", async () => {
    const malformed = await post("/admin/api/mcp-servers/mutate", {
      action: "import",
      scope: "global",
      json: "{ not json",
      conversationId: CONVERSATION_ID,
    });
    const legacy = await post("/admin/api/mcp-servers/mutate", {
      action: "set",
      scope: "global",
      name: "s",
      server: { url: "https://s.test/mcp" },
      conversationId: CONVERSATION_ID,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/not valid JSON/);
    expect(legacy.status).toBe(400);
    expect(globalSettings().mcpServers).toBeUndefined();
  });
});
