import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenConnectorClient } from "../connector/client.js";
import { connectionNameFor, ConnectorGateway } from "../connector/gateway.js";
import { ConnectorConnectionStore } from "../connector/store.js";
import { FileVaultManager } from "../vault/index.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { startWebServer } from "../web/server.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once("listening", resolve));
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function startFlow(options?: { connectorResponses?: (url: string) => unknown }): Promise<{
  url: string;
  token: string;
  vaultId: string;
  notify: ReturnType<typeof vi.fn>;
}> {
  const stateDir = join(tmpdir(), `mikan-connector-portal-${Date.now()}-${Math.random()}`);
  dirs.push(stateDir);

  const fetchFn: typeof fetch = async (input) => {
    const body = options?.connectorResponses?.(String(input)) ?? [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const gateway = new ConnectorGateway({
    client: new OpenConnectorClient({
      baseUrl: "http://connector.internal:3000",
      runtimeToken: "runtime-token",
      adminToken: "admin-token",
      fetchFn,
    }),
    store: new ConnectorConnectionStore(stateDir),
  });

  const tokenStore = new InMemoryLinkTokenStore();
  const token = tokenStore.create("telegram", "U100", "100", "vault-u100", "");
  const notify = vi.fn().mockResolvedValue(undefined);
  const server = startWebServer({
    port: 0,
    linkTokenStore: tokenStore,
    vaultManager: new FileVaultManager(stateDir),
    notify,
    connector: gateway,
  });
  servers.push(server);
  await waitForListening(server);
  return { url: baseUrl(server), token: token.token, vaultId: "vault-u100", notify };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("connector portal", () => {
  test("the /link page advertises the connector page only when configured", async () => {
    const { url, token } = await startFlow();
    const page = await (await fetch(`${url}/link?token=${token}`)).text();
    expect(page).toContain(`/connector?token=${token}`);
  });

  test("GET /connector rejects an invalid token and serves status for a valid one", async () => {
    const { url, token } = await startFlow();
    expect((await fetch(`${url}/connector?token=bogus`)).status).toBe(400);
    const page = await (await fetch(`${url}/connector?token=${token}`)).text();
    expect(page).toContain("Gmail");
    expect(page).toContain("GitHub (personal)");
  });

  test("start returns the authorization URL from the connector admin API", async () => {
    const { url, token } = await startFlow({
      connectorResponses: (target) =>
        target.endsWith("/api/oauth/authorizations")
          ? { authorizationUrl: "https://accounts.google.com/auth?state=1", state: "1" }
          : [],
    });
    const { status, body } = await postJson(`${url}/api/connector/start`, {
      token,
      service: "gmail",
    });
    expect(status).toBe(200);
    expect(body.authorizationUrl).toContain("accounts.google.com");
  });

  test("status persists the connection and notifies the conversation exactly once", async () => {
    const { url, token, vaultId, notify } = await startFlow({
      connectorResponses: (target) =>
        target.endsWith("/api/connections")
          ? [
              {
                service: "gmail",
                connectionName: connectionNameFor(vaultId, "gmail"),
                configured: true,
              },
            ]
          : [],
    });

    const first = await postJson(`${url}/api/connector/status`, { token, service: "gmail" });
    expect(first).toMatchObject({ status: 200, body: { connected: true } });
    const second = await postJson(`${url}/api/connector/status`, { token, service: "gmail" });
    expect(second).toMatchObject({ status: 200, body: { connected: true } });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("telegram", "100", expect.stringContaining("Gmail"));
  });

  test("mutations enforce the JSON content-type CSRF defense", async () => {
    const { url, token } = await startFlow();
    const response = await fetch(`${url}/api/connector/start`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ token, service: "gmail" }),
    });
    expect(response.status).toBe(415);
  });

  test("unknown services and expired tokens are rejected", async () => {
    const { url, token } = await startFlow();
    expect(
      (await postJson(`${url}/api/connector/start`, { token, service: "dropbox" })).status,
    ).toBe(400);
    expect(
      (await postJson(`${url}/api/connector/start`, { token: "bogus", service: "gmail" })).status,
    ).toBe(400);
  });
});
