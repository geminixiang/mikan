import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { provisionOfficeOpenConnectorToken } from "../mcp/open-connector.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-open-connector-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENCONNECTOR_ADMIN_TOKEN;
  delete process.env.MIKAN_OPENCONNECTOR_ADMIN_TOKEN;
  delete process.env.OPENCONNECTOR_ORIGIN;
  delete process.env.MIKAN_OPENCONNECTOR_ORIGIN;
  rmSync(dir, { recursive: true, force: true });
});

function testOffice() {
  return createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") }).office(
    createOfficeAddress("slack", "C123"),
  );
}

const servers = {
  "open-connector": {
    url: "http://127.0.0.1:3737/mcp",
    headers: { Authorization: "Bearer deployment-token" },
  },
  other: { url: "https://mcp.example.test" },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("provisionOfficeOpenConnectorToken", () => {
  test("keeps the configured deployment token when automatic provisioning is not enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await provisionOfficeOpenConnectorToken(testOffice(), "T123", servers);

    expect(result).toBe(servers);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("creates and persists a Slack conversation runtime token", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    process.env.OPENCONNECTOR_ORIGIN = "http://127.0.0.1:3737";
    const expectedName = "mikan:slack:T123:C123";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          deployment: {
            allowedActions: ["googlesheets.values_get"],
            blockedActions: ["gmail.send_message"],
            allowedProxies: [],
            blockedProxies: ["*"],
          },
          runtime: {
            allowedActions: [],
            blockedActions: [],
            allowedProxies: [],
            blockedProxies: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: "oct_conversation-secret",
          record: { id: "token-1", name: expectedName },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const office = testOffice();

    const result = await provisionOfficeOpenConnectorToken(office, "T123", servers);

    expect(result?.["open-connector"]?.headers).toEqual({
      Authorization: "Bearer oct_conversation-secret",
    });
    expect(result?.other).toEqual(servers.other);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      "http://127.0.0.1:3737/api/runtime-policy",
    );
    const creation = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(creation.headers).toEqual({
      Authorization: "Bearer admin-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(creation.body))).toEqual({
      name: expectedName,
      allowedActions: ["googlesheets.values_get"],
      blockedActions: ["gmail.send_message"],
      allowedProxies: [],
    });

    const statePath = join(office.stateDir, "open-connector-runtime-token.json");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 1,
      origin: "http://127.0.0.1:3737",
      name: expectedName,
      id: "token-1",
      token: "oct_conversation-secret",
    });
  });

  test("reuses the persisted token without another admin request", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    process.env.OPENCONNECTOR_ORIGIN = "http://127.0.0.1:3737";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          deployment: {
            allowedActions: [],
            blockedActions: [],
            allowedProxies: [],
            blockedProxies: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: "oct_conversation-secret",
          record: { id: "token-1", name: "mikan:slack:T123:C123" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const office = testOffice();

    await provisionOfficeOpenConnectorToken(office, "T123", servers);
    fetchMock.mockClear();
    const result = await provisionOfficeOpenConnectorToken(office, "T123", servers);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.["open-connector"]?.headers?.Authorization).toBe(
      "Bearer oct_conversation-secret",
    );
  });

  test("creates only one token during concurrent runner construction", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    process.env.OPENCONNECTOR_ORIGIN = "http://127.0.0.1:3737";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          deployment: { allowedActions: [], blockedActions: [], allowedProxies: [] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: "oct_conversation-secret",
          record: { id: "token-1", name: "mikan:slack:T123:C123" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const office = testOffice();

    const results = await Promise.all([
      provisionOfficeOpenConnectorToken(office, "T123", servers),
      provisionOfficeOpenConnectorToken(office, "T123", servers),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result?.["open-connector"]?.headers?.Authorization)).toEqual([
      "Bearer oct_conversation-secret",
      "Bearer oct_conversation-secret",
    ]);
  });

  test("never sends the admin token to a conversation-overridden origin", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    process.env.OPENCONNECTOR_ORIGIN = "http://127.0.0.1:3737";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await provisionOfficeOpenConnectorToken(testOffice(), "T123", {
      ...servers,
      "open-connector": { url: "https://attacker.example/mcp" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result?.["open-connector"]?.disabled).toBe(true);
  });

  test("disables only OpenConnector when provisioning fails", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    process.env.OPENCONNECTOR_ORIGIN = "http://127.0.0.1:3737";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "down" }, 503)));

    const result = await provisionOfficeOpenConnectorToken(testOffice(), "T123", servers);

    expect(result?.["open-connector"]?.disabled).toBe(true);
    expect(result?.other).toEqual(servers.other);
  });
});
