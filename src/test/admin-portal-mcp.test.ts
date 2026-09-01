import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findMcpPreset, listMcpPresets, materializeMcpPreset } from "../mcp/catalog.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { FileVaultManager } from "../vault/index.js";
import { handleAdminRequest, InMemoryAdminTokenStore } from "../web/admin/portal.js";
import type { AdminServices } from "../web/admin/types.js";

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

    expect(presets.map((preset) => preset.id)).toEqual([
      "github",
      "context7",
      "playwright",
      "sequential-thinking",
    ]);
    for (const preset of presets) {
      expect(JSON.stringify(preset.server)).not.toContain("@latest");
      expect(preset.sourceUrl).toMatch(/^https:\/\/github\.com\//);
    }
  });

  test("materializes credential values without mutating the preset", () => {
    const preset = findMcpPreset("github")!;

    expect(materializeMcpPreset(preset, { Authorization: "github_pat_123" })).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer github_pat_123" },
    });
    expect(preset.server).toEqual({ url: "https://api.githubcopilot.com/mcp/" });
  });

  test("rejects a missing required credential", () => {
    expect(() => materializeMcpPreset(findMcpPreset("context7")!, {})).toThrow(
      "Context7 API key is required",
    );
  });
});

describe("Admin MCP preset API", () => {
  test("lists presets with the two settings scopes", async () => {
    const response = await get(`/admin/api/mcp-servers?conversationId=${CONVERSATION_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.presets.map((preset: { id: string }) => preset.id)).toContain("github");
    expect(response.body.global).toEqual({});
    expect(response.body.conversation).toEqual({});
  });

  test("installs a credentialed preset and redacts its value on read", async () => {
    const installed = await post("/admin/api/mcp-servers/mutate", {
      action: "install",
      scope: "global",
      presetId: "github",
      credentials: { Authorization: "github_pat_123" },
      conversationId: CONVERSATION_ID,
    });

    expect(installed).toMatchObject({ status: 200, body: { ok: true } });
    expect(globalSettings().mcpServers.github).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer github_pat_123" },
    });

    const listed = await get(`/admin/api/mcp-servers?conversationId=${CONVERSATION_ID}`);
    expect(listed.body.global.github).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      envKeys: [],
      headerKeys: ["Authorization"],
    });
    expect(JSON.stringify(listed.body.global)).not.toContain("github_pat_123");
  });

  test("installs a pinned local preset", async () => {
    const installed = await post("/admin/api/mcp-servers/mutate", {
      action: "install",
      scope: "global",
      presetId: "playwright",
      credentials: {},
      conversationId: CONVERSATION_ID,
    });

    expect(installed.status).toBe(200);
    expect(globalSettings().mcpServers.playwright).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.80"],
    });
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
      presetId: "github",
      credentials: {},
      conversationId: CONVERSATION_ID,
    });

    expect(unknown).toMatchObject({ status: 400, body: { error: "unknown MCP preset" } });
    expect(missing).toMatchObject({
      status: 400,
      body: { error: "GitHub personal access token is required" },
    });
    expect(globalSettings().mcpServers).toBeUndefined();
  });
});
