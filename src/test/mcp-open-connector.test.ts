import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ensureDefaultOpenConnector,
  migrateLegacyOpenConnectorTokens,
} from "../harness/open-connector.js";
import { loadScopeMcpServers, resolveConversationSettings } from "../settings/index.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";

let dir: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-open-connector-"));
  stateDir = join(dir, "state");
  process.env.STATE_DIR = stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({ llm: { provider: "faux", model: "m", thinkingLevel: "off" } }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCONNECTOR_ADMIN_TOKEN;
  delete process.env.MIKAN_OPENCONNECTOR_ADMIN_TOKEN;
  delete process.env.STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  return createWorkspace({ root: join(dir, "workspace"), stateDir });
}

function testOffice(conversationId = "C123") {
  return workspace().office(createOfficeAddress("slack", conversationId));
}

const defaultServer = { url: "http://127.0.0.1:3737/mcp" };

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubProvisioning(tokens = ["oct_conversation-secret"]) {
  let created = 0;
  const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
    if (init?.method !== "POST") {
      return jsonResponse({
        deployment: {
          allowedActions: ["googlesheets.values_get"],
          blockedActions: ["gmail.send_message"],
          allowedProxies: [],
        },
      });
    }
    const body = JSON.parse(String(init.body)) as { name: string };
    const token = tokens[created] ?? `oct_${created}`;
    created++;
    return jsonResponse({ token, record: { id: `token-${created}`, name: body.name } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ensureDefaultOpenConnector", () => {
  test("provisions a token and writes an ordinary conversation MCP entry", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    const fetchMock = stubProvisioning();
    const office = testOffice();
    mkdirSync(office.stateDir, { recursive: true });
    writeFileSync(
      join(office.stateDir, "settings.json"),
      JSON.stringify({ llm: { model: "conversation-model" } }),
    );

    await ensureDefaultOpenConnector(office, "T123", defaultServer);

    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      "http://127.0.0.1:3737/api/runtime-policy",
    );
    const creation = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(creation).toEqual({
      name: "mikan:slack:T123:C123",
      allowedActions: ["googlesheets.values_get"],
      blockedActions: ["gmail.send_message"],
      allowedProxies: [],
    });
    const settingsPath = join(office.stateDir, "settings.json");
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(saved.llm).toEqual({ model: "conversation-model" });
    expect(saved.mcpServers).toEqual({
      "open-connector": {
        url: defaultServer.url,
        headers: { Authorization: "Bearer oct_conversation-secret" },
      },
    });
    expect(resolveConversationSettings(office).mcpServers?.["open-connector"]).toEqual(
      saved.mcpServers["open-connector"],
    );
  });

  test("leaves a conversation-declared server alone", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    const fetchMock = stubProvisioning();
    const office = testOffice();
    mkdirSync(office.stateDir, { recursive: true });
    const own = {
      "open-connector": {
        url: "https://self-hosted.example/mcp",
        headers: { Authorization: "Bearer own-token" },
      },
    };
    writeFileSync(join(office.stateDir, "settings.json"), JSON.stringify({ mcpServers: own }));

    await ensureDefaultOpenConnector(office, "T123", defaultServer);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadScopeMcpServers(office).conversation).toEqual(own);
  });

  test("leaves a globally declared or disabled server alone", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    const fetchMock = stubProvisioning();
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ mcpServers: { "open-connector": { url: "https://global.example/mcp" } } }),
    );
    await ensureDefaultOpenConnector(testOffice("C1"), "T123", defaultServer);

    const disabled = testOffice("C2");
    mkdirSync(disabled.stateDir, { recursive: true });
    writeFileSync(
      join(disabled.stateDir, "settings.json"),
      JSON.stringify({ mcpServers: { "open-connector": { disabled: true } } }),
    );
    writeFileSync(join(stateDir, "settings.json"), JSON.stringify({}));
    await ensureDefaultOpenConnector(disabled, "T123", defaultServer);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadScopeMcpServers(disabled).conversation).toEqual({
      "open-connector": { disabled: true },
    });
  });

  test("does nothing without a default server, admin token, or Slack workspace", async () => {
    const fetchMock = stubProvisioning();
    await ensureDefaultOpenConnector(testOffice(), "T123", undefined);
    await ensureDefaultOpenConnector(testOffice(), "T123", defaultServer);
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    await ensureDefaultOpenConnector(testOffice(), undefined, defaultServer);
    await ensureDefaultOpenConnector(
      workspace().office(createOfficeAddress("discord", "C123")),
      "T123",
      defaultServer,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadScopeMcpServers(testOffice()).conversation).toEqual({});
  });

  test("creates only one token during concurrent runner construction", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    const fetchMock = stubProvisioning();
    const office = testOffice();
    await Promise.all([
      ensureDefaultOpenConnector(office, "T123", defaultServer),
      ensureDefaultOpenConnector(office, "T123", defaultServer),
    ]);
    await ensureDefaultOpenConnector(office, "T123", defaultServer);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  test("reports provisioning failure without writing settings", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "down" }, 503)));
    const office = testOffice();
    await expect(ensureDefaultOpenConnector(office, "T123", defaultServer)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(loadScopeMcpServers(office).conversation).toEqual({});
  });
});

describe("migrateLegacyOpenConnectorTokens", () => {
  test("converts legacy token files into conversation MCP entries and removes them", () => {
    const office = testOffice();
    office.ensure();
    mkdirSync(office.stateDir, { recursive: true });
    const legacyPath = join(office.stateDir, "open-connector-runtime-token.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        origin: "http://127.0.0.1:3737",
        name: "mikan:slack:T123:C123",
        id: "token-1",
        token: "oct_legacy",
      }),
    );
    const declared = testOffice("C9");
    declared.ensure();
    mkdirSync(declared.stateDir, { recursive: true });
    writeFileSync(join(declared.stateDir, "open-connector-runtime-token.json"), "{}");
    writeFileSync(
      join(declared.stateDir, "settings.json"),
      JSON.stringify({ mcpServers: { "open-connector": { url: "https://own.example/mcp" } } }),
    );

    const report = migrateLegacyOpenConnectorTokens(stateDir, defaultServer.url);

    expect(report).toEqual({
      migrated: [office.key],
      skipped: [{ key: declared.key, reason: "open-connector is already declared" }],
    });
    expect(loadScopeMcpServers(office).conversation).toEqual({
      "open-connector": {
        url: defaultServer.url,
        headers: { Authorization: "Bearer oct_legacy" },
      },
    });
    expect(() => statSync(legacyPath)).toThrow();
    expect(statSync(join(declared.stateDir, "open-connector-runtime-token.json")).isFile()).toBe(
      true,
    );
  });

  test("skips tokens minted for a different origin", () => {
    const office = testOffice();
    office.ensure();
    mkdirSync(office.stateDir, { recursive: true });
    writeFileSync(
      join(office.stateDir, "open-connector-runtime-token.json"),
      JSON.stringify({
        version: 1,
        origin: "https://old.example",
        name: "mikan:slack:T123:C123",
        id: "token-1",
        token: "oct_legacy",
      }),
    );
    expect(migrateLegacyOpenConnectorTokens(stateDir, defaultServer.url)).toEqual({
      migrated: [],
      skipped: [{ key: office.key, reason: "token origin https://old.example differs" }],
    });
    expect(loadScopeMcpServers(office).conversation).toEqual({});
  });
});
