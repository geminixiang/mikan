import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessBootstrap,
  HarnessEventEnvelope,
} from "@geminixiang/mikan-harness-web-contract";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HarnessHost } from "../web/harness/types.js";
import { InMemoryWebSessionStore } from "../web/login/session-store.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { startWebServer } from "../web/server.js";
import { FileVaultManager } from "../vault/index.js";

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Harness HTTP transport", () => {
  test("authenticates bootstrap and validates JSON commands", async () => {
    const fixture = await startFixture();
    expect((await fetch(`${fixture.base}/api/harness/bootstrap`)).status).toBe(401);
    expect((await fetch(`${fixture.base}/admin?token=bad`)).status).toBe(404);

    const bootstrap = await fetch(`${fixture.base}/api/harness/bootstrap`, {
      headers: { Cookie: fixture.cookie },
    });
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      principal: { id: "github:101", displayName: "octo" },
      cursor: { epoch: "epoch", sequence: 0 },
    });

    const wrongType = await fetch(`${fixture.base}/api/harness/command`, {
      method: "POST",
      headers: { Cookie: fixture.cookie },
      body: JSON.stringify({ kind: "create-conversation", commandId: "c1" }),
    });
    expect(wrongType.status).toBe(415);

    const command = await fetch(`${fixture.base}/api/harness/command`, {
      method: "POST",
      headers: { Cookie: fixture.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "create-conversation", commandId: "c1" }),
    });
    expect(command.status).toBe(200);
    await expect(command.json()).resolves.toEqual({
      kind: "prompt-accepted",
      runId: "run-1",
    });
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({ id: "github:101" }), {
      kind: "create-conversation",
      commandId: "c1",
    });

    const invalidCursor = await fetch(`${fixture.base}/api/harness/events`, {
      headers: { Cookie: fixture.cookie },
    });
    expect(invalidCursor.status).toBe(400);
  });

  test("streams ordered envelopes over the authenticated SSE route", async () => {
    const fixture = await startFixture(true);
    const controller = new AbortController();
    const response = await fetch(`${fixture.base}/api/harness/events?epoch=epoch&after=0`, {
      headers: { Cookie: fixture.cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const chunk = await response.body?.getReader().read();
    controller.abort();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain("id: 1");
    expect(text).toContain('"kind":"diagnostic"');
  });
});

async function startFixture(streamImmediately = false) {
  const stateDir = mkdtempSync(join(tmpdir(), "mikan-harness-http-"));
  dirs.push(stateDir);
  const sessions = new InMemoryWebSessionStore();
  const { sessionId } = sessions.create("github:101", "octo");
  const execute = vi.fn().mockResolvedValue({ kind: "prompt-accepted", runId: "run-1" });
  const bootstrap: HarnessBootstrap = {
    principal: { id: "github:101", displayName: "octo" },
    conversations: [],
    models: [],
    cursor: { epoch: "epoch", sequence: 0 },
  };
  const host: HarnessHost = {
    bootstrap: vi.fn().mockResolvedValue(bootstrap),
    execute,
    subscribe(_principal, _cursor, emit) {
      if (streamImmediately) emit(streamEnvelope());
      return { kind: "subscribed", dispose: () => {} };
    },
  };
  const server = await startWebServer({
    port: 0,
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(stateDir),
    notify: async () => {},
    webSessionStore: sessions,
    harnessHost: host,
  });
  if (!server) throw new Error("Web server failed to start");
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    cookie: `mikan_session=${sessionId}`,
    execute,
  };
}

function streamEnvelope(): HarnessEventEnvelope {
  return {
    cursor: { epoch: "epoch", sequence: 1 },
    event: {
      kind: "diagnostic",
      officeKey: "office",
      sessionId: "session",
      runId: "run",
      text: "working",
      tone: "muted",
    },
  };
}
