import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ConnectorError, OpenConnectorClient } from "../connector/client.js";
import { connectionNameFor, ConnectorGateway, CURATED_ACTIONS } from "../connector/gateway.js";
import { ConnectorConnectionStore } from "../connector/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake connector service: records requests and replays scripted responses. */
function fakeConnector(respond: (req: RecordedRequest) => { status?: number; body: unknown }): {
  fetchFn: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const recorded: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string> | undefined) ?? {}).map(
          ([key, value]) => [key.toLowerCase(), value],
        ),
      ),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);
    const { status = 200, body } = respond(recorded);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, requests };
}

function createGateway(respond: Parameters<typeof fakeConnector>[0]): {
  gateway: ConnectorGateway;
  requests: RecordedRequest[];
} {
  const stateDir = join(tmpdir(), `mikan-connector-test-${Date.now()}-${Math.random()}`);
  dirs.push(stateDir);
  const { fetchFn, requests } = fakeConnector(respond);
  const gateway = new ConnectorGateway({
    client: new OpenConnectorClient({
      baseUrl: "http://connector.internal:3000/",
      runtimeToken: "runtime-token",
      adminToken: "admin-token",
      fetchFn,
    }),
    store: new ConnectorConnectionStore(stateDir),
  });
  return { gateway, requests };
}

const PRINCIPAL = "v1-slack-office-a-0123456789abcdef";
const OTHER_PRINCIPAL = "v1-slack-office-b-fedcba9876543210";

function connectedListResponse(principal: string): { status?: number; body: unknown } {
  return {
    body: [
      {
        service: "gmail",
        connectionName: connectionNameFor(principal, "gmail"),
        configured: true,
      },
    ],
  };
}

describe("ConnectorGateway", () => {
  test("execute without a connection fails with a reconnect hint, not a provider call", async () => {
    const { gateway, requests } = createGateway(() => ({ body: {} }));
    await expect(
      gateway.execute(PRINCIPAL, "gmail_search", { query: "is:unread" }),
    ).rejects.toThrow(/No gmail connection.*\/login/s);
    expect(requests).toHaveLength(0);
  });

  test("onboarding start posts the deterministic connection name to the admin API", async () => {
    const { gateway, requests } = createGateway(() => ({
      body: { authorizationUrl: "https://accounts.google.com/o/oauth2/auth?x=1", state: "s" },
    }));
    const { authorizationUrl } = await gateway.startOnboarding(PRINCIPAL, "gmail");
    expect(authorizationUrl).toContain("accounts.google.com");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://connector.internal:3000/api/oauth/authorizations");
    expect(requests[0].headers.authorization).toBe("Bearer admin-token");
    expect(requests[0].body).toEqual({
      service: "gmail",
      connectionName: connectionNameFor(PRINCIPAL, "gmail"),
    });
  });

  test("completeOnboarding persists the mapping once and reports newly exactly once", async () => {
    const { gateway } = createGateway(() => connectedListResponse(PRINCIPAL));
    expect(await gateway.completeOnboarding(PRINCIPAL, "gmail")).toEqual({
      connected: true,
      newly: true,
    });
    expect(await gateway.completeOnboarding(PRINCIPAL, "gmail")).toEqual({
      connected: true,
      newly: false,
    });
    expect(gateway.status(PRINCIPAL).find((s) => s.service === "gmail")?.connected).toBe(true);
  });

  test("completeOnboarding stays pending until the connection is configured", async () => {
    const { gateway } = createGateway(() => ({ body: [] }));
    expect(await gateway.completeOnboarding(PRINCIPAL, "gmail")).toEqual({
      connected: false,
      newly: false,
    });
    expect(gateway.status(PRINCIPAL).find((s) => s.service === "gmail")?.connected).toBe(false);
  });

  test("one principal's connection never leaks to another principal", async () => {
    const { gateway } = createGateway(() => connectedListResponse(PRINCIPAL));
    await gateway.completeOnboarding(PRINCIPAL, "gmail");
    // The other principal's deterministic name is absent from the connector.
    expect(await gateway.completeOnboarding(OTHER_PRINCIPAL, "gmail")).toEqual({
      connected: false,
      newly: false,
    });
    await expect(gateway.execute(OTHER_PRINCIPAL, "gmail_search", { query: "x" })).rejects.toThrow(
      /No gmail connection/,
    );
  });

  test("execute routes through the curated actionId with the principal's alias", async () => {
    const { gateway, requests } = createGateway((req) => {
      if (req.url.endsWith("/api/connections")) return connectedListResponse(PRINCIPAL);
      return { body: { success: true, message: "OK", data: { threads: [] } } };
    });
    await gateway.completeOnboarding(PRINCIPAL, "gmail");
    const result = await gateway.execute(PRINCIPAL, "gmail_search", { query: "is:unread" });
    expect(JSON.parse(result)).toEqual({ threads: [] });

    const actionRequest = requests.at(-1)!;
    expect(actionRequest.url).toBe(
      `http://connector.internal:3000/v1/actions/${encodeURIComponent(CURATED_ACTIONS.gmail_search.actionId)}`,
    );
    expect(actionRequest.headers.authorization).toBe("Bearer runtime-token");
    expect(actionRequest.headers["x-oo-connector-alias"]).toBe(
      connectionNameFor(PRINCIPAL, "gmail"),
    );
    expect(actionRequest.body).toEqual({ input: { query: "is:unread" } });
  });

  test("oversized action results are truncated", async () => {
    const { gateway } = createGateway((req) => {
      if (req.url.endsWith("/api/connections")) return connectedListResponse(PRINCIPAL);
      return { body: { success: true, data: { blob: "x".repeat(100_000) } } };
    });
    await gateway.completeOnboarding(PRINCIPAL, "gmail");
    const result = await gateway.execute(PRINCIPAL, "gmail_search", { query: "q" });
    expect(result.length).toBeLessThan(41_000);
    expect(result).toContain("truncated");
  });

  test("connector error envelopes surface code and message", async () => {
    const { gateway } = createGateway((req) => {
      if (req.url.endsWith("/api/connections")) return connectedListResponse(PRINCIPAL);
      return {
        status: 400,
        body: { error: { code: "connection_not_found", message: "Reconnect the account." } },
      };
    });
    await gateway.completeOnboarding(PRINCIPAL, "gmail");
    const failure = await gateway.execute(PRINCIPAL, "gmail_search", { query: "q" }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(ConnectorError);
    expect((failure as ConnectorError).code).toBe("connection_not_found");
    expect((failure as ConnectorError).message).toBe("Reconnect the account.");
  });

  test("disconnect removes the connector credential and the local mapping", async () => {
    const { gateway, requests } = createGateway((req) => {
      if (req.url.endsWith("/api/connections")) return connectedListResponse(PRINCIPAL);
      return { body: {} };
    });
    await gateway.completeOnboarding(PRINCIPAL, "gmail");
    await gateway.disconnect(PRINCIPAL, "gmail");

    const deleteRequest = requests.at(-1)!;
    expect(deleteRequest.method).toBe("DELETE");
    expect(deleteRequest.url).toContain("/api/connections/gmail?connectionName=");
    expect(gateway.status(PRINCIPAL).find((s) => s.service === "gmail")?.connected).toBe(false);
  });

  test("connection names satisfy the connector's constraints and stay unlinkable", () => {
    const name = connectionNameFor(PRINCIPAL, "googlecalendar");
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    expect(name).not.toContain("office-a");
    expect(name).not.toBe(connectionNameFor(OTHER_PRINCIPAL, "googlecalendar"));
  });
});
