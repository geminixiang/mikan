import type { UserMessage } from "@earendil-works/pi-ai";
import { existsSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createWorkspace, officeKey, officeSessionsDir } from "../office/index.js";
import { openManagedSession, createManagedSessionFile } from "../sessions/store.js";
import { FileVaultManager } from "../vault/index.js";
import type { WebAuthRequestOptions } from "../web/auth/portal.js";
import { WebAuthRegistry } from "../web/auth/registry.js";
import { WebHarnessService } from "../web/harness/service.js";
import { InMemoryLinkTokenStore } from "../web/login/store.js";
import { startWebServer } from "../web/server.js";

let dir: string;
let server: Server;
let url: string;
let registry: WebAuthRegistry;
let cookies: string;
let csrf: string;
let accountId: string;
let workspaceRoot: string;

async function waitForListening(value: Server): Promise<void> {
  if (value.listening) return;
  await new Promise<void>((resolve) => value.once("listening", resolve));
}

function baseUrl(value: Server): string {
  const address = value.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}

function mutationHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Cookie: cookies,
    Origin: url,
    "Content-Type": "application/json",
    "X-Mikan-CSRF": csrf,
    ...extra,
  };
}

beforeEach(async () => {
  dir = join(tmpdir(), `mikan-web-harness-${Date.now()}-${Math.random()}`);
  registry = new WebAuthRegistry(join(dir, "state"));
  const account = registry.completeOAuthIdentity({
    provider: "github",
    subject: "12345",
    displayName: "Example User",
  }).account;
  accountId = account.id;
  const session = registry.createLoginSession(account.id);
  cookies = `mikan_web_session=${session.token}; mikan_web_csrf=${session.csrfToken}`;
  csrf = session.csrfToken;
  const auth: WebAuthRequestOptions = { registry, providers: {} };
  workspaceRoot = join(dir, "workspace");
  const workspace = createWorkspace({
    root: workspaceRoot,
    stateDir: join(dir, "state"),
  });
  server = startWebServer({
    port: 0,
    linkTokenStore: new InMemoryLinkTokenStore(),
    vaultManager: new FileVaultManager(join(dir, "state")),
    notify: async () => {},
    webAuth: auth,
    webHarness: { auth, service: new WebHarnessService(registry, workspace) },
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

describe("Web workspace APIs", () => {
  test("lists the Personal workspace and creates a materialized Web office", async () => {
    const initial = await fetch(`${url}/api/web/workspaces`, { headers: { Cookie: cookies } });
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      workspaces: Array<{ id: string; name: string }>;
    };
    expect(initialBody.workspaces).toHaveLength(1);
    expect(initialBody.workspaces[0]?.name).toBe("Personal");

    const created = await fetch(`${url}/api/web/workspaces`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ name: "Research" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { workspace: { id: string; name: string } };
    expect(body.workspace.name).toBe("Research");
    const officePath = join(
      dir,
      "workspace",
      officeKey({ platform: "web", conversationId: body.workspace.id }),
    );
    expect(existsSync(officePath)).toBe(true);
  });

  test("renames without changing workspace identity or office path", async () => {
    const record = registry.createWorkspace(accountId, "Before");
    const beforeKey = officeKey({ platform: "web", conversationId: record.id });

    const response = await fetch(`${url}/api/web/workspaces/${record.id}`, {
      method: "PATCH",
      headers: mutationHeaders(),
      body: JSON.stringify({ name: "After" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { id: record.id, name: "After" },
    });
    expect(officeKey({ platform: "web", conversationId: record.id })).toBe(beforeKey);
  });

  test("returns the same not-found result for unknown and foreign workspaces", async () => {
    const other = registry.completeOAuthIdentity({
      provider: "google",
      subject: "other",
      displayName: "Other",
    }).account;
    const foreign = registry.listWorkspaces(other.id)[0]!;

    for (const workspaceId of ["wsp_missing", foreign.id]) {
      const sessions = await fetch(`${url}/api/web/workspaces/${workspaceId}/sessions`, {
        headers: { Cookie: cookies },
      });
      expect(sessions.status).toBe(404);
      await expect(sessions.json()).resolves.toEqual({ error: "Workspace not found" });
    }
  });

  test("requires authenticated CSRF-protected JSON mutations", async () => {
    const unauthenticated = await fetch(`${url}/api/web/workspaces`);
    expect(unauthenticated.status).toBe(401);

    const noCsrf = await fetch(`${url}/api/web/workspaces`, {
      method: "POST",
      headers: { Cookie: cookies, Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Denied" }),
    });
    expect(noCsrf.status).toBe(401);

    const wrongType = await fetch(`${url}/api/web/workspaces`, {
      method: "POST",
      headers: mutationHeaders({ "Content-Type": "text/plain" }),
      body: JSON.stringify({ name: "Denied" }),
    });
    expect(wrongType.status).toBe(415);
  });

  test("lists sessions and loads history only by opaque session id", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const officePath = join(
      workspaceRoot,
      officeKey({ platform: "web", conversationId: workspaceId }),
    );
    const sessionFile = createManagedSessionFile(officeSessionsDir(officePath), officePath);
    const session = await openManagedSession(sessionFile, officePath);
    await session.setSessionName("Browser session");
    await session.appendMessage({
      role: "user",
      content: [{ type: "text", text: "private browser history" }],
      timestamp: 1,
    } satisfies UserMessage);
    const sessionId = session.getHeader().id;

    const sessions = await fetch(`${url}/api/web/workspaces/${workspaceId}/sessions`, {
      headers: { Cookie: cookies },
    });
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          id: sessionId,
          title: "Browser session",
          entryCount: 1,
          current: true,
        }),
      ],
    });

    const history = await fetch(
      `${url}/api/web/workspaces/${workspaceId}/history?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { Cookie: cookies } },
    );
    expect(history.status).toBe(200);
    const body = (await history.json()) as {
      session: { sessionId: string; fileName?: string; items: Array<{ body?: string }> };
    };
    expect(body.session.sessionId).toBe(sessionId);
    expect(body.session.fileName).toBeUndefined();
    expect(body.session.items[0]?.body).toContain("private browser history");
  });

  test("does not expose history from a foreign workspace", async () => {
    const ownWorkspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const ownOfficePath = join(
      workspaceRoot,
      officeKey({ platform: "web", conversationId: ownWorkspaceId }),
    );
    const ownSessionFile = createManagedSessionFile(
      officeSessionsDir(ownOfficePath),
      ownOfficePath,
    );
    const ownSession = await openManagedSession(ownSessionFile, ownOfficePath);
    const opaqueId = ownSession.getHeader().id;

    const other = registry.completeOAuthIdentity({
      provider: "google",
      subject: "history-owner",
      displayName: "History Owner",
    }).account;
    const foreignWorkspaceId = registry.listWorkspaces(other.id)[0]!.id;
    const response = await fetch(
      `${url}/api/web/workspaces/${foreignWorkspaceId}/history?sessionId=${encodeURIComponent(opaqueId)}`,
      { headers: { Cookie: cookies } },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });

  test("returns empty sessions and does not accept raw filenames as session ids", async () => {
    const workspaceId = registry.listWorkspaces(accountId)[0]!.id;
    const sessions = await fetch(`${url}/api/web/workspaces/${workspaceId}/sessions`, {
      headers: { Cookie: cookies },
    });
    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({ sessions: [] });

    const history = await fetch(
      `${url}/api/web/workspaces/${workspaceId}/history?sessionId=${encodeURIComponent("current")}`,
      { headers: { Cookie: cookies } },
    );
    expect(history.status).toBe(404);
    await expect(history.json()).resolves.toEqual({ error: "Session not found" });
  });
});
